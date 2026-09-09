/** dsh-scheduler host half — cron store, Vixie-cron engine, shell executor, API + model tool. */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

export const name = "dsh-scheduler";
export const inject = ["timer", "shell", "webServer", "tools"];

const MAX_RUNS_PER_JOB = 20;
const SCAN_MINUTES = 8 * 24 * 60;
const CATCHUP_LOOKBACK_MINUTES = 24 * 60;
const MAX_BODY_BYTES = 1_000_000;

/** Arrow apply: the loader treats a `function apply` declaration inconsistently across runtimes (documented dsh-boo pitfall) — arrows are the verified form. */
export const apply = (ctx, config) => {
  const cfg = config || {};
  const refreshMs = Number.isFinite(cfg.refreshMs) && cfg.refreshMs >= 5000 ? cfg.refreshMs : 30000;
  const defaultTimeoutMs = Number.isFinite(cfg.defaultTimeoutMs) && cfg.defaultTimeoutMs >= 1000 && cfg.defaultTimeoutMs <= 3600000 ? cfg.defaultTimeoutMs : 900000;
  const catchUpOnStart = cfg.catchUpOnStart !== false;
  const importFrom = Array.isArray(cfg.importFrom) ? cfg.importFrom.filter((p) => typeof p === "string") : [];

  const logger = ctx.logger("dsh-scheduler");
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
  const storeDir = join(dshHome, "scheduler");
  const storePath = join(storeDir, "jobs.json");
  const backupPath = storePath + ".bak";

  const state = { jobs: [], loaded: false, lastTickAt: null, startedAt: new Date().toISOString(), firedCount: 0 };
  const cronCache = new Map();

  // ---- persistence (plugin-owned data in $DSH_HOME: direct node fs, atomic write) ----
  async function readStoreFile(path) {
    const jobs = await readStoreJobs(path);
    // A process killed mid-run persists jobs with running: true; a reload must
    // normalize them or the job never fires (and cannot be removed) again.
    return jobs.map((j) => (j && j.running === true ? { ...j, running: false } : j));
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

  async function saveStore() {
    await mkdir(storeDir, { recursive: true });
    const payload = JSON.stringify({ version: 1, jobs: state.jobs }, null, 2) + "\n";
    try {
      const current = await readFile(storePath, "utf8");
      await writeFile(backupPath, current, "utf8");
    } catch { /* backup is best-effort */ }
    const tmp = storePath + ".tmp-" + process.pid + "-" + Date.now();
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
    job.running = true;
    const run = { startedAt: new Date().toISOString(), trigger, durationMs: null, exitCode: null, timedOut: false, ok: false, stdoutTail: "", stderrTail: "" };
    if (!Array.isArray(job.runs)) job.runs = [];
    job.runs.unshift(run);
    if (job.runs.length > MAX_RUNS_PER_JOB) job.runs.length = MAX_RUNS_PER_JOB;
    saveStore().catch(() => {});
    ctx.emit("dsh-scheduler/job-started", { id: job.id, name: job.name, trigger });
    const started = Date.now();
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
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const workdir = typeof args.workdir === "string" && args.workdir.trim() ? args.workdir.trim() : null;
    const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs >= 1000 && args.timeoutMs <= 3600000 ? Math.floor(args.timeoutMs) : null;
    if (!name || name.length > 80) return Promise.resolve({ ok: false, error: "name required (max 80 chars)" });
    if (state.jobs.some((j) => j.name === name)) return Promise.resolve({ ok: false, error: "a job named " + name + " already exists" });
    if (!parseCron(args.cron)) return Promise.resolve({ ok: false, error: "invalid cron expression (5-field m h dom mon dow)" });
    if (!command || command.length > 2000) return Promise.resolve({ ok: false, error: "command required (max 2000 chars)" });
    const job = {
      id: "j" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36),
      name, cron: args.cron.trim(), command, workdir,
      timeoutMs, enabled: true, createdAt: new Date().toISOString(),
      lastFiredMinute: null, running: false, runs: [],
    };
    state.jobs.unshift(job);
    cronCache.delete(job.id);
    return saveStore().then(() => ({ ok: true, id: job.id, job: jobView(job) })).catch((e) => {
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
      return { ok: false, error: "save failed: " + String(e && e.message ? e.message : e) };
    });
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
            if (state.jobs.some((j) => j.name === job.name)) continue;
            state.jobs.push({
              id: "j" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36),
              name: job.name.slice(0, 80), cron: job.cron, command: job.command.slice(0, 2000),
              workdir: typeof job.workdir === "string" ? job.workdir : null,
              timeoutMs: typeof job.timeoutMs === "number" ? job.timeoutMs : null,
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
          return op(body.value).then((result) => sendJson(res, 200, result));
        }).catch((e) => sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }));
      },
    }));
  }

  // `scheduler` model tool.
  disposers.push(ctx.tools.register({
    name: "scheduler",
    description: "Manage dsh-scheduler cron jobs: list scheduled jobs, add a new one (5-field cron, shell command, workdir), remove, enable/disable, or fire one now. Jobs execute through the harness shell while the DSH process runs.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "toggle", "runNow"], description: "Operation to perform." },
        id: { type: "string", description: "Job id (required for remove/toggle/runNow)." },
        name: { type: "string", description: "Job name (required for add, unique)." },
        cron: { type: "string", description: "Cron expression, 5 fields m h dom mon dow; supports *, */n, lists, ranges. Day of week 0-7 (7=Sunday). Day-of-month OR day-of-week applies only when BOTH are restricted (Vixie semantics)." },
        command: { type: "string", description: "Shell command to run (required for add)." },
        workdir: { type: "string", description: "Working directory (optional)." },
        timeoutMs: { type: "number", description: "Timeout in ms, 1000-3600000 (optional, default 900000)." },
      },
      required: ["action"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(args, value) { return [{ type: "text", text: JSON.stringify(value, null, 2) }]; },
    },
    execute(args) { return dispatch(args); },
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
