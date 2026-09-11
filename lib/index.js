/** dsh-scheduler host half — cron store, Vixie-cron engine, agent-invocation + shell executor, API + model tool. */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, isAbsolute } from "node:path";

export const name = "dsh-scheduler";
export const inject = ["timer", "shell", "webServer", "tools"];

const MAX_RUNS_PER_JOB = 20;
const SCAN_MINUTES = 8 * 24 * 60;
const CATCHUP_LOOKBACK_MINUTES = 24 * 60;
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_AGENT_PRESET = "standard";
const DEFAULT_PERMISSION_PRESET = "workspace-write";

/** Arrow apply: the loader treats a `function apply` declaration inconsistently across runtimes (documented dsh-boo pitfall) — arrows are the verified form. */
export const apply = (ctx, config) => {
  const cfg = config || {};
  const refreshMs = Number.isFinite(cfg.refreshMs) && cfg.refreshMs >= 5000 ? cfg.refreshMs : 30000;
  const defaultTimeoutMs = Number.isFinite(cfg.defaultTimeoutMs) && cfg.defaultTimeoutMs >= 1000 && cfg.defaultTimeoutMs <= 3600000 ? cfg.defaultTimeoutMs : 900000;
  const catchUpOnStart = cfg.catchUpOnStart !== false;
  const importFrom = Array.isArray(cfg.importFrom) ? cfg.importFrom.filter((p) => typeof p === "string") : [];
  const defaultAgentPreset = typeof cfg.defaultAgentPreset === "string" && cfg.defaultAgentPreset.trim() ? cfg.defaultAgentPreset.trim() : DEFAULT_AGENT_PRESET;
  const defaultPermissionPreset = typeof cfg.defaultPermissionPreset === "string" && cfg.defaultPermissionPreset.trim() ? cfg.defaultPermissionPreset.trim() : DEFAULT_PERMISSION_PRESET;

  const logger = ctx.logger("dsh-scheduler");
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
  const storeDir = join(dshHome, "scheduler");
  const storePath = join(storeDir, "jobs.json");
  const backupPath = storePath + ".bak";

  const state = { jobs: [], loaded: false, lastTickAt: null, startedAt: new Date().toISOString(), firedCount: 0 };
  const cronCache = new Map();

  // ---- scheduled agent invocations (optional webhookRuntime) ----
  // The web composition mounts @deepseek-ai/dsh-webhook only when a profile
  // layer inserts it (id: webhook-runtime). Optional-inject keeps the plugin
  // usable without the runtime: agent-job add then fails with an actionable
  // error and shell jobs are untouched.
  let webhookRuntime = null;
  let agentPresetCatalog = null;
  let permissionPresetCatalog = null;
  let webhookDisposer = null;
  try {
    ctx.inject(["webhookRuntime"], (whCtx) => {
      webhookRuntime = whCtx.webhookRuntime;
      try { agentPresetCatalog = whCtx.agentPresets; } catch { agentPresetCatalog = null; }
      try { permissionPresetCatalog = whCtx.permissionPresets; } catch { permissionPresetCatalog = null; }
      webhookDisposer = webhookRuntime.register({
        id: "dsh-scheduler/agent-invocations",
        kind: "scheduler",
        run(delivery, signal) {
          // Pure same-process mapping: the contract allows a sync return, so
          // the signal only gates the host's own awaits before publication.
          void signal;
          return buildAgentSessionRequest(delivery.event);
        },
      });
      return webhookDisposer;
    });
  } catch { /* no webhookRuntime in this composition — agent jobs stay unavailable */ }

  // ---- persistence (plugin-owned data in $DSH_HOME: direct node fs, atomic write) ----
  // Set by readStoreFile when load-time normalization changed anything (a
  // stuck running flag, a dropped ambiguous command): the init chain persists
  // it after state.jobs is assigned. A saveStore inside readStoreFile itself
  // would write state.jobs — still empty on the init path — and wipe the
  // just-read jobs from disk.
  let storeNeedsRewrite = false;
  async function readStoreFile(path) {
    const jobs = await readStoreJobs(path);
    // A process killed mid-run persists jobs with running: true; a reload must
    // normalize them or the job never fires (and cannot be removed) again.
    // map returns the same reference for unchanged jobs, so identity detects
    // which entries were normalized.
    const normalized = jobs.map((j, i) => {
      if (j && j.running === true) { storeNeedsRewrite = true; return { ...j, running: false }; }
      return j;
    });
    // Hand-edited stores may break addJob's exclusivity invariant (command AND
    // agentPrompt on one job): the load path must restore the same invariant,
    // or such a job fires as an agent invocation and the shell command never
    // runs with no signal. fireJob classifies by agentPrompt, so drop command.
    for (const j of normalized) {
      if (j && typeof j.agentPrompt === "string" && j.agentPrompt.trim() && typeof j.command === "string" && j.command.trim()) {
        logger.warn("dsh-scheduler: job", j.name, "carries both command and agentPrompt; keeping the agent prompt and dropping the command (addJob guarantees exactly one of the two)");
        j.command = null;
        storeNeedsRewrite = true;
      }
    }
    return normalized;
  }

  async function loadStore() {
    try {
      return await readStoreFile(storePath);
    } catch (mainError) {
      try {
        const jobs = await readStoreFile(backupPath);
        logger.error("dsh-scheduler: main store unreadable, recovered from .bak");
        return jobs;
      } catch {
        throw mainError;
      }
    }
  }

  // Saves are serialized: fireJob fires saves without awaiting, and two
  // overlapping writes shared one tmp name (pid + Date.now collide within the
  // same millisecond) — interleaved chunks tore the store and a lost update
  // could drop a just-added job. A save chain orders every write, and each
  // write snapshots state.jobs at its own turn, so the last write is the
  // freshest state.
  let saveChain = Promise.resolve();
  function saveStore() {
    const next = saveChain.then(writeStoreFile);
    saveChain = next.then(() => undefined, () => undefined);
    return next;
  }
  async function writeStoreFile() {
    await mkdir(storeDir, { recursive: true });
    const payload = JSON.stringify({ version: 1, jobs: state.jobs }, null, 2) + "\n";
    try {
      const current = await readFile(storePath, "utf8");
      await writeFile(backupPath, current, "utf8");
    } catch { /* backup is best-effort */ }
    // Random suffix: two same-millisecond saves no longer share one tmp path
    // even if a future change ever writes concurrently again.
    const tmp = storePath + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6).toString(36);
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, storePath);
  }

  // ---- cron engine: 5 fields, *, */n, lists, ranges, Vixie day semantics (pure helpers live at module scope below) ----

  function parsed(job) {
    if (!cronCache.has(job.id)) cronCache.set(job.id, parseCron(job.cron));
    return cronCache.get(job.id);
  }

  // ---- execution ----
  async function fireJob(job, trigger) {
    if (job.running) return;
    const agentJob = typeof job.agentPrompt === "string" && job.agentPrompt.trim() !== "";
    // Agent invocations are instantaneous dispatches and hold no running
    // lock; shell jobs stay marked running until the command settles.
    job.running = !agentJob;
    const run = { startedAt: new Date().toISOString(), trigger, durationMs: null, exitCode: null, timedOut: false, ok: false, stdoutTail: "", stderrTail: "" };
    if (!Array.isArray(job.runs)) job.runs = [];
    job.runs.unshift(run);
    if (job.runs.length > MAX_RUNS_PER_JOB) job.runs.length = MAX_RUNS_PER_JOB;
    saveStore().catch(() => {});
    ctx.emit("dsh-scheduler/job-started", { id: job.id, name: job.name, trigger });
    const started = Date.now();
    if (agentJob) {
      // Agent invocation: hand the request to the host's webhookRuntime, which
      // creates one fresh root Session (workspace + preset + prompt). The
      // runtime is fire-and-forget — an accepted dispatch is this run's whole
      // outcome; the created Session follows ordinary lifecycle afterward.
      try {
        webhookRuntime.dispatch({
          kind: "scheduler",
          source: "dsh-scheduler",
          deliveryId: job.id + "-" + started,
          receivedAt: started,
          event: {
            jobId: job.id, name: job.name, cron: job.cron,
            agentPrompt: job.agentPrompt, workdir: job.workdir,
            agentPreset: job.agentPreset || defaultAgentPreset,
            permissionPreset: job.permissionPreset || defaultPermissionPreset,
            // An own undefined-valued property makes the whole delivery
            // lossless-JSON-invalid (snapshotJsonValue rejects it) and the
            // real webhook runtime throws — omit the key entirely instead.
            ...(job.model ? { model: job.model } : {}),
            trigger,
          },
        });
        run.durationMs = Date.now() - started;
        run.exitCode = 0;
        run.ok = true;
        run.stdoutTail = "[agent invocation dispatched] " + renderAgentPrompt(job, trigger);
      } catch (e) {
        run.durationMs = Date.now() - started;
        run.stderrTail = tail(String(e && e.message ? e.message : e));
        run.ok = false;
      } finally {
        state.firedCount++;
        saveStore().catch((e) => logger.error("dsh-scheduler: save failed:", String(e)));
        logger.info("dsh-scheduler: agent job", job.name, "(" + trigger + ") dispatched ok=" + run.ok);
        ctx.emit("dsh-scheduler/agent-invoked", { id: job.id, name: job.name, trigger, ok: run.ok });
      }
      return;
    }
    try {
      const shell = ctx.shell;
      // Each job is confined to its own workdir (workspace-write): the same
      // bounds a session's tools get, generalized per job. Jobs without a
      // workdir run under the executor's default policy.
      const res = await shell.run({
        command: job.command,
        workdir: job.workdir || undefined,
        timeoutMs: job.timeoutMs || defaultTimeoutMs,
        stdoutMaxBytes: 4 * 1024 * 1024,
        sandboxPolicy: job.workdir ? { mode: "workspace-write", workspaceRoot: job.workdir } : undefined,
      });
      run.durationMs = Date.now() - started;
      run.exitCode = res.exitCode;
      run.timedOut = res.timedOut === true;
      run.ok = res.exitCode === 0 && !run.timedOut;
      run.stdoutTail = res.stdout ? tail(res.stdout.text) : "";
      run.stderrTail = res.stderr ? tail(res.stderr.text) : "";
      if (res.sandbox && res.sandbox.denied) {
        run.ok = false;
        run.stderrTail = (run.stderrTail ? run.stderrTail + "\n" : "") + "[sandbox denied: " + JSON.stringify(res.sandbox) + "]";
      }
    } catch (e) {
      run.durationMs = Date.now() - started;
      run.stderrTail = tail(String(e && e.message ? e.message : e));
      run.ok = false;
    } finally {
      job.running = false;
      state.firedCount++;
      saveStore().catch((e) => logger.error("dsh-scheduler: save failed:", String(e)));
      logger.info("dsh-scheduler: job", job.name, "(" + trigger + ") ok=" + run.ok, "exit=" + run.exitCode, "dur=" + run.durationMs + "ms");
      ctx.emit("dsh-scheduler/job-finished", { id: job.id, name: job.name, trigger, ok: run.ok, exitCode: run.exitCode, durationMs: run.durationMs });
    }
  }

  // ---- tick ----
  /** Most recent matching minute within the lookback window that this job has not fired, for anacron-style catch-up after downtime or sleep. */
  function missedMatch(job, lookbackMinutes) {
    const cron = parsed(job);
    if (!cron) return null;
    const now = new Date();
    const fired = job.lastFiredMinute;
    for (let i = 1; i <= lookbackMinutes; i++) {
      const d = new Date(now.getTime() - i * 60000);
      if (fired !== null && fired !== undefined && fired === localMinuteKey(d)) return null;
      if (cronMatches(cron, d)) return d;
    }
    return null;
  }

  function tick() {
    const now = new Date();
    const lastTickMs = state.lastTickAt ? new Date(state.lastTickAt).getTime() : null;
    state.lastTickAt = now.toISOString();
    // A tick gap far larger than the interval means sleep or suspension: fire
    // the most recent missed occurrence once instead of dropping it silently.
    if (lastTickMs !== null && now.getTime() - lastTickMs > 90000) {
      for (const job of state.jobs) {
        if (!job.enabled || job.running) continue;
        const missed = missedMatch(job, CATCHUP_LOOKBACK_MINUTES);
        if (missed) {
          job.lastFiredMinute = localMinuteKey(missed);
          logger.info("dsh-scheduler: firing missed run of", job.name, "from", missed.toISOString());
          fireJob(job, "catchup");
        }
      }
      return;
    }
    const mk = localMinuteKey(now);
    for (const job of state.jobs) {
      if (!job.enabled || job.running) continue;
      if (job.lastFiredMinute === mk) continue;
      const cron = parsed(job);
      if (!cron) continue;
      if (cronMatches(cron, now)) {
        job.lastFiredMinute = mk;
        fireJob(job, "schedule");
      }
    }
  }

  // ---- operations ----
  function summarizeRun(r) {
    return { startedAt: r.startedAt, trigger: r.trigger, durationMs: r.durationMs, exitCode: r.exitCode, timedOut: r.timedOut, ok: r.ok, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail };
  }

  function jobView(job) {
    const cron = parsed(job);
    return {
      id: job.id, name: job.name, cron: job.cron, command: job.command,
      workdir: job.workdir || null, timeoutMs: job.timeoutMs || null,
      agentPrompt: job.agentPrompt || null,
      agentPreset: job.agentPreset || null,
      permissionPreset: job.permissionPreset || null,
      model: job.model || null,
      agentJob: typeof job.agentPrompt === "string" && job.agentPrompt.trim() !== "",
      enabled: job.enabled === true, running: job.running === true,
      cronValid: cron !== null,
      nextRun: (job.enabled === true && cron) ? nextRunIso(cron, new Date()) : null,
      lastRun: job.runs && job.runs.length ? summarizeRun(job.runs[0]) : null,
      runCount: job.runs ? job.runs.length : 0,
    };
  }

  function snapshot() {
    return {
      ok: true, loaded: state.loaded, startedAt: state.startedAt,
      lastTickAt: state.lastTickAt, firedCount: state.firedCount, storePath,
      jobs: state.jobs.map(jobView),
    };
  }

  function addJob(args) {
    args = args || {};
    return addJobAsync(args);
  }

  async function addJobAsync(args) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const workdir = typeof args.workdir === "string" && args.workdir.trim() ? args.workdir.trim() : null;
    const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 1000 && args.timeoutMs <= 3600000 ? Math.floor(args.timeoutMs) : null;
    const agentPrompt = typeof args.agentPrompt === "string" && args.agentPrompt.trim() ? args.agentPrompt.trim() : null;
    const agentPreset = typeof args.agentPreset === "string" && args.agentPreset.trim() ? args.agentPreset.trim() : null;
    const permissionPreset = typeof args.permissionPreset === "string" && args.permissionPreset.trim() ? args.permissionPreset.trim() : null;
    const model = args.model && typeof args.model === "object" && !Array.isArray(args.model)
      && typeof args.model.provider === "string" && typeof args.model.model === "string"
      ? { provider: args.model.provider, model: args.model.model, ...(Number.isSafeInteger(args.model.maxTokens) && args.model.maxTokens > 0 ? { maxTokens: args.model.maxTokens } : {}) }
      : null;
    if (!name || name.length > 80) return Promise.resolve({ ok: false, error: "name required (max 80 chars)" });
    if (state.jobs.some((j) => j.name === name)) return Promise.resolve({ ok: false, error: "a job named " + name + " already exists" });
    if (!parseCron(args.cron)) return Promise.resolve({ ok: false, error: "invalid cron expression (5-field m h dom mon dow)" });
    if (agentPrompt && command) return Promise.resolve({ ok: false, error: "provide either command (shell job) or agentPrompt (agent job), not both" });
    if (!command && !agentPrompt) return Promise.resolve({ ok: false, error: "command (shell job) or agentPrompt (agent job) required" });
    if (command && command.length > 2000) return Promise.resolve({ ok: false, error: "command required (max 2000 chars)" });
    if (agentPrompt) {
      if (agentPrompt.length > 4000) return Promise.resolve({ ok: false, error: "agentPrompt too long (max 4000 chars)" });
      if (!webhookRuntime) return Promise.resolve({ ok: false, error: "agent jobs need the webhook runtime: add the insert row { id: webhook-runtime, name: '@deepseek-ai/dsh-webhook' } to the profile patch and restart dsh web" });
      if (!workdir) return Promise.resolve({ ok: false, error: "agent jobs require workdir: it becomes the workspace the invocation runs in" });
      if (!isAbsolute(workdir)) return Promise.resolve({ ok: false, error: "agent jobs require an absolute workdir (it becomes the workspace path), got " + workdir });
      const presetError = await validateAgentPresets({ agentPreset, permissionPreset });
      if (presetError) return Promise.resolve({ ok: false, error: presetError });
    }
    // Re-check after the await above (validateAgentPresets): a concurrent add
    // with the same name could have stored while this call was suspended, and
    // the uniqueness invariant would break.
    if (state.jobs.some((j) => j.name === name)) return Promise.resolve({ ok: false, error: "a job named " + name + " already exists" });
    const job = {
      id: "j" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36),
      name, cron: args.cron.trim(), command: agentPrompt ? null : command, workdir,
      timeoutMs, enabled: true, createdAt: new Date().toISOString(),
      lastFiredMinute: null, running: false, runs: [],
      ...(agentPrompt ? {
        agentPrompt,
        agentPreset: agentPreset || defaultAgentPreset,
        permissionPreset: permissionPreset || defaultPermissionPreset,
        ...(model ? { model } : {}),
      } : {}),
    };
    state.jobs.unshift(job);
    cronCache.delete(job.id);
    return saveStore().then(() => ({ ok: true, id: job.id, job: jobView(job) })).catch((e) => {
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
      return { ok: false, error: "save failed: " + String(e && e.message ? e.message : e) };
    });
  }

  /** Tool-path add gate: a scheduled prompt is untrusted task content (the repo's own framing), so a job added through the model tool may not widen the caller's authority. Returns an error string, or null when the add may proceed. The human's own GUI/HTTP adds are unchanged. */
  function gateAgentAdd(args, exec) {
    if (!args || args.action !== "add") return null;
    const workdir = typeof args.workdir === "string" && args.workdir.trim() ? args.workdir.trim() : null;
    // Unattended escalation: the shipped danger-full-access preset composes a
    // root session with no approval gate, and the cron fires it unattended.
    // The effective preset is judged (a configured default widens too).
    if ((args.permissionPreset || defaultPermissionPreset) === "danger-full-access") {
      return "permissionPreset danger-full-access is not allowed through the scheduler tool (the job would fire unattended with no approval gate); add it through the Cron jobs overlay in the GUI instead";
    }
    if (!workdir) return null;
    // Workspace widening / lateral movement: a shell job's workdir becomes the
    // sandbox root and an agent job's workdir becomes the invocation's Web
    // Workspace, so a workdir outside the calling session's own workspace
    // would let scheduled work reach another tree unattended. Evaluated only
    // when the caller's workspace is known (the agent loop sets exec.agent;
    // dsh-tools always passes the execution as the second execute argument).
    const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : null;
    const cwd = header && typeof header.cwd === "string" ? header.cwd : null;
    if (cwd === null) return null; // caller workspace unknown — addJob's own validation still applies
    if (!isPathWithin(workdir, cwd)) {
      return "workdir must stay within the calling session's workspace (" + cwd + "), got " + workdir;
    }
    return null;
  }

  /** Add-time preset validation through the live preset services: unknown names fail loudly at setup, not at fire time. The shipped AgentPresets roster is async, so the call is awaited; the configured default preset is validated too when the job omits one (that name would otherwise resolve only at fire time). */
  async function validateAgentPresets({ agentPreset, permissionPreset }) {
    if (agentPresetCatalog && typeof agentPresetCatalog.list === "function") {
      let known = null;
      try { known = await agentPresetCatalog.list(); } catch { known = null; }
      if (Array.isArray(known)) {
        const names = known.map((p) => (p && typeof p === "object" ? p.id : p)).filter((n) => typeof n === "string");
        // Validate both the job's choice and the effective default when the job omits one.
        const wanted = [agentPreset, agentPreset ? null : defaultAgentPreset].filter((n) => typeof n === "string");
        for (const preset of wanted) {
          if (!names.includes(preset)) return "unknown agent preset " + preset + " (available: " + names.join(", ") + ")";
        }
      }
    }
    if (permissionPresetCatalog && typeof permissionPresetCatalog.resolve === "function") {
      try {
        permissionPresetCatalog.resolve(permissionPreset || defaultPermissionPreset);
      } catch {
        return "unknown permission preset " + (permissionPreset || defaultPermissionPreset);
      }
    }
    return null;
  }

  /** Build the WebhookSessionRequest the host's webhookRuntime consumes, or null for an unusable event. */
  function buildAgentSessionRequest(event) {
    if (!event || typeof event !== "object") return null;
    const workdir = typeof event.workdir === "string" && isAbsolute(event.workdir) ? event.workdir : null;
    const agentPrompt = typeof event.agentPrompt === "string" && event.agentPrompt.trim() ? event.agentPrompt.trim() : null;
    if (!workdir || !agentPrompt) return null;
    return {
      workspacePath: workdir,
      title: typeof event.name === "string" && event.name.trim() ? event.name.trim() : "Scheduled task",
      prompt: renderAgentPrompt({ name: event.name, cron: event.cron, agentPrompt }, event.trigger),
      agentPreset: typeof event.agentPreset === "string" && event.agentPreset.trim() ? event.agentPreset.trim() : defaultAgentPreset,
      permissionPreset: typeof event.permissionPreset === "string" && event.permissionPreset.trim() ? event.permissionPreset.trim() : defaultPermissionPreset,
      ...(event.model && typeof event.model === "object" && typeof event.model.provider === "string" && typeof event.model.model === "string"
        ? { model: { provider: event.model.provider, model: event.model.model, ...(Number.isSafeInteger(event.model.maxTokens) && event.model.maxTokens > 0 ? { maxTokens: event.model.maxTokens } : {}) } }
        : {}),
    };
  }

  function findJob(args) {
    const id = args && typeof args.id === "string" ? args.id : null;
    if (!id) return null;
    return state.jobs.find((j) => j.id === id) || null;
  }

  function removeJob(args) {
    const job = findJob(args);
    if (!job) return Promise.resolve({ ok: false, error: "unknown job id" });
    if (job.running) return Promise.resolve({ ok: false, error: "job is running; wait for it to finish" });
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
    cronCache.delete(job.id);
    return saveStore().then(() => ({ ok: true }));
  }

  function toggleJob(args) {
    const job = findJob(args);
    if (!job) return Promise.resolve({ ok: false, error: "unknown job id" });
    job.enabled = !job.enabled;
    return saveStore().then(() => ({ ok: true, enabled: job.enabled }));
  }

  function runNow(args) {
    const job = findJob(args);
    if (!job) return Promise.resolve({ ok: false, error: "unknown job id" });
    if (job.running) return Promise.resolve({ ok: false, error: "already running" });
    fireJob(job, "manual");
    return Promise.resolve({ ok: true, started: true, id: job.id });
  }

  function dispatch(args) {
    args = args || {};
    if (!state.loaded) return Promise.resolve({ ok: false, error: "scheduler still loading" });
    switch (args.action) {
      case "list": return Promise.resolve(snapshot());
      case "add": return addJob(args);
      case "remove": return removeJob(args);
      case "toggle": return toggleJob(args);
      case "runNow": return runNow(args);
      default: return Promise.resolve({ ok: false, error: "action must be list|add|remove|toggle|runNow" });
    }
  }

  // ---- init: load store (or start empty), optional import, optional catch-up, then tick ----
  loadStore().catch((e) => {
    // Fresh start (no store file yet) or unreadable store — not fatal.
    logger.error("dsh-scheduler: store load failed, starting empty:", String(e && e.message ? e.message : e));
    return [];
  }).then(async (jobs) => {
    // The normalization in readStoreFile mutates `jobs` in place; persist it
    // after assignment (state.jobs must be current before any saveStore).
    state.jobs = jobs;
    // One-time import from legacy stores named in the patch config
    // (importFrom): only when this store is empty (including the
    // fresh-start path above), never overwriting existing names.
    if (state.jobs.length === 0 && importFrom.length > 0) {
      for (const legacyPath of importFrom) {
        try {
          const legacy = await readStoreFile(legacyPath);
          let imported = 0;
          for (const job of legacy) {
            if (!job || typeof job.name !== "string" || typeof job.cron !== "string" || typeof job.command !== "string") continue;
            // The same validity gates addJob enforces: an imported job with an
            // unparsable cron would never fire (silently dead), and an
            // out-of-range timeout would break the 1000-3600000 invariant.
            if (!parseCron(job.cron)) { logger.warn("dsh-scheduler: import skipped", job.name, "- invalid cron", job.cron); continue; }
            if (state.jobs.some((j) => j.name === job.name)) continue;
            const timeout = typeof job.timeoutMs === "number" && job.timeoutMs >= 1000 && job.timeoutMs <= 3600000 ? Math.floor(job.timeoutMs) : null;
            state.jobs.push({
              id: "j" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36),
              name: job.name.slice(0, 80), cron: job.cron, command: job.command.slice(0, 2000),
              workdir: typeof job.workdir === "string" ? job.workdir : null,
              timeoutMs: timeout,
              enabled: job.enabled !== false, createdAt: new Date().toISOString(),
              lastFiredMinute: null, running: false, runs: [], importedFrom: legacyPath,
            });
            imported++;
          }
          if (imported > 0) {
            await saveStore();
            logger.info("dsh-scheduler: imported", imported, "job(s) from", legacyPath);
          }
        } catch (e) {
          logger.error("dsh-scheduler: import from", legacyPath, "failed:", String(e && e.message ? e.message : e));
        }
      }
    }
    // Persist load-time normalization (stuck running flags, dropped ambiguous
    // commands) once, after state.jobs is current.
    if (storeNeedsRewrite) { await saveStore().catch(() => {}); storeNeedsRewrite = false; }
    state.loaded = true;
    for (const job of state.jobs) cronCache.delete(job.id);
    logger.info("dsh-scheduler: loaded", state.jobs.length, "job(s) from", storePath);
    // Catch up on runs missed while the process was down (anacron-style,
    // once per job), then enter the regular tick cadence.
    if (catchUpOnStart) {
      for (const job of state.jobs) {
        if (!job.enabled || job.running) continue;
        const missed = missedMatch(job, CATCHUP_LOOKBACK_MINUTES);
        if (missed) {
          job.lastFiredMinute = localMinuteKey(missed);
          logger.info("dsh-scheduler: firing missed run of", job.name, "from", missed.toISOString());
          fireJob(job, "catchup");
        }
      }
    }
    tick();
  });

  // ---- lifecycle-owned contributions ----
  const disposers = [];
  disposers.push(ctx.interval(tick, refreshMs));

  // API routes for the client half (lossless JSON only).
  const sendJson = (res, status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  };
  // Route fence (mirrors client-connection's isTrustedApiRequest, which plugin
  // routes registered directly on the webserver bypass otherwise): a DNS
  // rebinding Host or a cross-site form POST must not reach shell execution.
  const lanAddresses = ctx.webServer.host === "0.0.0.0"
    ? Object.values(networkInterfaces()).flat().filter((i) => i !== void 0 && i.family === "IPv4" && !i.internal).map((i) => i.address)
    : [];
  const bindHost = ctx.webServer.host;
  const fence = (req) => fenceRequest(req, bindHost, lanAddresses);
  const mutations = { add: addJob, remove: removeJob, toggle: toggleJob, runNow };
  disposers.push(ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-scheduler",
    handler(req, res) {
      if (!fence(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
      sendJson(res, 404, { error: "not-found" });
    },
  }));
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-scheduler/snapshot",
    handler(req, res) {
      if (!fence(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
      if (req.method !== "GET") { sendJson(res, 405, { error: "method-not-allowed" }); return; }
      sendJson(res, 200, snapshot());
    },
  }));
  for (const [action, op] of Object.entries(mutations)) {
    disposers.push(ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-scheduler/" + action,
      handler(req, res) {
        if (!fence(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
        if (req.method !== "POST") { sendJson(res, 405, { error: "method-not-allowed" }); return; }
        readBody(req).then((body) => {
          if (body.tooLarge) { sendJson(res, 413, { ok: false, error: "request body too large" }); return; }
          if (body.invalid) { sendJson(res, 400, { ok: false, error: "invalid JSON body" }); return; }
          // The same loaded gate the model tool path applies: the init chain
          // ends with `state.jobs = jobs`, so a mutation landing before
          // loadStore completes is silently overwritten (an added job would
          // vanish).
          if (!state.loaded) { sendJson(res, 503, { ok: false, error: "scheduler still loading" }); return; }
          return op(body.value).then((result) => sendJson(res, 200, result));
        }).catch((e) => sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }));
      },
    }));
  }

  // `scheduler` model tool.
  disposers.push(ctx.tools.register({
    name: "scheduler",
    description: "Manage dsh-scheduler jobs: list scheduled jobs, add a new one, remove, enable/disable, or fire one now. A shell job carries a command run through the harness shell while the DSH process runs; an agent job carries agentPrompt — at the cron minute it starts one fresh root agent session (titled with the job name) in the workdir workspace via the harness webhook runtime.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "toggle", "runNow"], description: "Operation to perform." },
        id: { type: "string", description: "Job id (required for remove/toggle/runNow)." },
        name: { type: "string", description: "Job name (required for add, unique)." },
        cron: { type: "string", description: "Cron expression, 5 fields m h dom mon dow; supports *, */n, lists, ranges. Day of week 0-7 (7=Sunday). Day-of-month OR day-of-week applies only when BOTH are restricted (Vixie semantics)." },
        command: { type: "string", description: "Shell command to run (shell job; exactly one of command/agentPrompt)." },
        agentPrompt: { type: "string", description: "Task for a scheduled agent invocation (agent job; exactly one of command/agentPrompt). Requires an absolute workdir and the webhook runtime; the invocation creates one fresh root session in that workspace." },
        workdir: { type: "string", description: "Working directory (optional for shell jobs, required and absolute for agent jobs — it becomes the workspace)." },
        agentPreset: { type: "string", description: "Agent preset for the invocation session (optional, default " + DEFAULT_AGENT_PRESET + ")." },
        permissionPreset: { type: "string", description: "Sandbox/approval preset for the invocation session (optional, default " + DEFAULT_PERMISSION_PRESET + ")." },
        model: { type: "object", description: "Explicit model route {provider, model, maxTokens?} (optional; omission uses the deployment default)." },
        timeoutMs: { type: "number", description: "Shell-job timeout in ms, 1000-3600000 (optional, default 900000)." },
      },
      required: ["action"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) { return [{ type: "text", text: JSON.stringify(value, null, 2) }]; },
    },
    execute(args, exec) {
      // A scheduled prompt is untrusted task content (the repo's own framing),
      // so a job added through the model tool may not widen the caller's
      // authority: no unattended danger-full-access root session, no
      // fire-time workspace outside the calling session's own.
      const gate = gateAgentAdd(args, exec);
      if (gate) return Promise.resolve({ ok: false, error: gate });
      return dispatch(args);
    },
    timeoutMs: 60000,
  }));

  return () => {
    for (const d of disposers) d();
  };
};

// ---- exported pure helpers (module scope so node:test can exercise them) ----

/** Truncate captured output to the last lines, capped at 2048 chars. */
export const tail = (s) => {
  if (!s) return "";
  const lines = String(s).split("\n");
  const t = lines.slice(-12).join("\n");
  return t.length > 2048 ? t.slice(-2048) : t;
};

/**
 * Build the invocation prompt the agent sees: a provenance header naming the
 * scheduling source, then the task. The prompt itself stays untrusted task
 * content — the header labels where it came from, the created session owns
 * whatever the prompt asks for.
 */
export const renderAgentPrompt = (job, trigger) => {
  const parts = [
    "[SCHEDULED TASK]",
    "This session was started by the dsh-scheduler cron job below.",
    "job: " + (job && job.name ? job.name : "unnamed"),
    "cron: " + (job && job.cron ? job.cron : "?"),
    "trigger: " + (trigger || "schedule"),
    "",
    String(job && job.agentPrompt ? job.agentPrompt : ""),
  ];
  return parts.join("\n");
};

/** Parse one cron field: *, n, a-b, each with an optional /step (after * or a range; a bare "n/step" is rejected, cronie-faithful). */
export const parseCronField = (field, min, max) => parseCronFieldImpl(field, min, max);

function parseCronFieldImpl(field, min, max) {
  if (typeof field !== "string" || field.length === 0) return null;
  const out = new Set();
  for (const part of field.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (!/^\d+$/.test(stepStr) || Number(stepStr) === 0) return null;
      // cronie rejects a step after a bare number ("5/10" is invalid there;
      // silently treating it as "5" under-fires without any signal).
      if (range !== "*" && !range.includes("-")) return null;
      step = Number(stepStr);
    }
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (/^\d+$/.test(range)) { lo = hi = Number(range); }
    else {
      const dash = range.indexOf("-");
      if (dash === -1) return null;
      const a = range.slice(0, dash), b = range.slice(dash + 1);
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
      lo = Number(a); hi = Number(b);
    }
    // Vixie dow wrap: "5-0" is the legal Fri..Sun idiom; cronie remaps a
    // wrapped range ending in 0 to the full 0-7 week.
    if (max === 7 && lo > hi && hi === 0) hi = 7;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  const vals = Array.from(out);
  if (max === 7) for (let i = 0; i < vals.length; i++) if (vals[i] === 7) vals[i] = 0;
  return vals.sort((a, b) => a - b);
}

/** Parse a 5-field Vixie cron expression to its minute/hour/dom/mon/dow sets, or null. */
export const parseCron = (engineExpr) => {
  if (typeof engineExpr !== "string") return null;
  const f = engineExpr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mins = parseCronFieldImpl(f[0], 0, 59);
  const hours = parseCronFieldImpl(f[1], 0, 23);
  const doms = parseCronFieldImpl(f[2], 1, 31);
  const mons = parseCronFieldImpl(f[3], 1, 12);
  const dows = parseCronFieldImpl(f[4], 0, 7);
  if (!mins || !hours || !doms || !mons || !dows) return null;
  // Vixie day semantics: dom-OR-dow applies only when BOTH are restricted;
  // when either is * it is an AND (the * field always matches).
  return { mins, hours, doms, mons, dows, domRestricted: f[2] !== "*", dowRestricted: f[4] !== "*" };
};

/** Whether one Date matches a parsed cron expression (Vixie dom/dow rules). */
export const cronMatches = (cron, d) => {
  const domMatch = cron.doms.indexOf(d.getDate()) !== -1;
  const dowMatch = cron.dows.indexOf(d.getDay()) !== -1;
  const dayMatch = (cron.domRestricted && cron.dowRestricted) ? (domMatch || dowMatch) : (domMatch && dowMatch);
  return cron.mins.indexOf(d.getMinutes()) !== -1
    && cron.hours.indexOf(d.getHours()) !== -1
    && dayMatch
    && cron.mons.indexOf(d.getMonth() + 1) !== -1;
};

/** Next matching minute after `from` (ISO string), scanning at most 8 days ahead. */
export const nextRunIso = (cron, from) => {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < SCAN_MINUTES; i++) {
    if (cronMatches(cron, d)) return d.toISOString();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
};

/** Local wall-clock minute key: two local renderings of one minute (DST fall-back repeats an hour) share a key, so one matching minute fires once even across the fold. */
export const localMinuteKey = (d) =>
  d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() + "-" + d.getHours() + "-" + d.getMinutes();

/**
 * Whether `candidate` is `root` itself or a path strictly inside it —
 * segment-boundary aware, so `/a/bc` is NOT within `/a/b`. Both sides must be
 * absolute; POSIX only (this is a macOS/Linux harness). Relative segments
 * (`..`, `.`) are not resolved: callers pass add-time trimmed values, and
 * `..`-carrying candidates fail the containment test (fail closed).
 */
export const isPathWithin = (candidate, root) => {
  if (typeof candidate !== "string" || typeof root !== "string" || !candidate || !root) return false;
  if (!isAbsolute(candidate) || !isAbsolute(root)) return false;
  if (candidate === root) return true;
  const norm = (p) => p.split("/").filter((s) => s.length > 0);
  const c = norm(candidate);
  const r = norm(root);
  if (c.length <= r.length) return false;
  if (c.includes("..") || r.includes("..")) return false;
  for (let i = 0; i < r.length; i++) if (c[i] !== r[i]) return false;
  return true;
};

/** Read one JSON request body, capped at MAX_BODY_BYTES: resolves {value} for valid JSON, {invalid:true} for unparseable bodies (400), {tooLarge:true} over the cap (413). */
export function readBody(req, maxBodyBytes) {
  const cap = maxBodyBytes || MAX_BODY_BYTES;
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > cap) { tooLarge = true; body = ""; return; }
      if (!tooLarge) body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) { resolve({ tooLarge: true }); return; }
      try { resolve({ value: body ? JSON.parse(body) : {} }); } catch { resolve({ invalid: true }); }
    });
  });
}

/** Read one store file and normalize stuck running flags. Throws on missing/malformed. */
async function readStoreJobs(path) {
  const text = await readFile(path, "utf8");
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.jobs)) throw new Error("malformed store");
  return data.jobs.map((j) => (j && j.running === true ? { ...j, running: false } : j));
}

/**
 * Route fence mirroring dsh-client-connection's isTrustedApiRequest: plugin
 * routes registered directly on the webserver bypass the host's /api fence,
 * so the same Host/Origin checks run here. Returns true only when the Host is
 * ours (loopback, or a local IPv4 address when bound to all interfaces) and
 * any attached browser markers are same-origin.
 */
export function fenceRequest(req, bindHost, lanAddresses) {
  const host = header(req.headers, "host");
  if (host === void 0) return false;
  const authority = parseAuthority(host);
  if (authority === void 0) return false;
  const hostname = authority.hostname.toLowerCase();
  if (!isLoopbackHostname(hostname) && !isLocalAddress(hostname, bindHost, lanAddresses || [])) return false;
  if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(req.headers, "origin");
  if (origin === void 0) return true;
  try { return new URL(origin).host === authority.host; } catch { return false; }
}

const header = (headers, name) => {
  const v = headers[name];
  if (v === void 0) return void 0;
  return Array.isArray(v) ? v[0] : v;
};

/** host[:port] → { hostname, host } with the bracketed IPv6 form handled; undefined when not a bare authority. */
function parseAuthority(value) {
  try {
    const url = new URL("http://" + value);
    if (url.pathname !== "/") return void 0;
    return { hostname: url.hostname, host: url.host };
  } catch {
    return void 0;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost" || hostname === "::1";
}

/** A non-loopback Host is acceptable only when the server binds all interfaces and the Host names one of this machine's own IPv4 addresses. */
function isLocalAddress(hostname, bindHost, lanAddresses) {
  if (bindHost !== "0.0.0.0" || lanAddresses.length === 0) return false;
  return lanAddresses.some((a) => a === hostname);
}
