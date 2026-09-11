/** Scheduled agent invocations: add-time validation, dispatch firing, prompt framing. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, renderAgentPrompt } from "../lib/index.js";

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sched-agent-test-"));
  try { return await fn(dir); } finally {
    for (let i = 0; i < 5; i++) {
      try { await rm(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
    }
  }
}

/** Minimal ctx stub with a captured webhookRuntime: dispatch() records deliveries and optionally throws. */
function makeCtx(opts = {}) {
  const ctx = {
    logger: () => ({ info() {}, error() {}, warn() {}, debug() {} }),
    emit() {},
    interval: () => () => {},
    shell: { run: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: { text: "" }, stderr: { text: "" } }) },
    webServer: { host: "127.0.0.1", register: () => () => {} },
    tools: { register: (tool) => { ctx.tool = tool; return () => {}; } },
  };
  if (opts.withWebhook !== false) {
    const dispatches = [];
    const failOnDispatch = opts.failOnDispatch;
    // Built eagerly so tests can reshape the catalogs before apply() captures them.
    ctx.webhook = {
      webhookRuntime: {
        register(rule) { ctx.rule = rule; return () => {}; },
        dispatch(delivery) {
          if (failOnDispatch) throw new Error("webhook runtime is closing");
          dispatches.push(delivery);
        },
      },
      // Minimal preset catalogs shaped like the real services.
      agentPresets: {
        list: () => [{ id: "standard" }, { id: "minimal" }],
      },
      permissionPresets: {
        resolve: (name) => {
          if (name !== "workspace-write" && name !== "danger-full-access") throw new Error("unknown preset " + name);
          return { sandbox: "workspace-write", approval: "ask" };
        },
      },
    };
    ctx.dispatches = dispatches;
    ctx.inject = (services, cb) => cb(ctx.webhook);
  }
  return ctx;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

/** A cron far in the future: the startup catch-up scan can never match it. */
const DORMANT_CRON = "0 3 29 2 1";
const ABS_DIR = "/Users/jacopobonta/workspace/live-portfolio";

test("agent-job add stores fields and presets", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const res = await ctx.tool.execute({ action: "add", name: "nightly-check", cron: DORMANT_CRON, agentPrompt: "check the codebase for bugs", workdir: ABS_DIR });
      assert.equal(res.ok, true, res.error);
      assert.equal(res.job.agentJob, true);
      assert.equal(res.job.agentPrompt, "check the codebase for bugs");
      assert.equal(res.job.agentPreset, "standard");
      assert.equal(res.job.permissionPreset, "workspace-write");
      assert.equal(res.job.command, null);
      assert.ok(ctx.rule);
      assert.equal(ctx.rule.kind, "scheduler");
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("agent-job add without webhookRuntime fails with the profile-row remedy", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx({ withWebhook: false });
      const dispose = apply(ctx, {});
      await settle();
      const res = await ctx.tool.execute({ action: "add", name: "orphan", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR });
      assert.equal(res.ok, false);
      assert.match(res.error, /webhook-runtime/);
      assert.match(res.error, /dsh-webhook/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("agent-job add rejects a relative workdir and a missing workdir", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const rel = await ctx.tool.execute({ action: "add", name: "rel", cron: DORMANT_CRON, agentPrompt: "task", workdir: "live-portfolio" });
      assert.equal(rel.ok, false);
      assert.match(rel.error, /absolute/);
      const none = await ctx.tool.execute({ action: "add", name: "none", cron: DORMANT_CRON, agentPrompt: "task" });
      assert.equal(none.ok, false);
      assert.match(none.error, /workdir/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("agent-job add rejects prompt+command together and both missing", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const both = await ctx.tool.execute({ action: "add", name: "both", cron: DORMANT_CRON, agentPrompt: "task", command: "true", workdir: ABS_DIR });
      assert.equal(both.ok, false);
      assert.match(both.error, /either command|not both|both/);
      const neither = await ctx.tool.execute({ action: "add", name: "neither", cron: DORMANT_CRON });
      assert.equal(neither.ok, false);
      assert.match(neither.error, /agentPrompt/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("agent-job add rejects unknown presets through the live catalogs", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const badAgent = await ctx.tool.execute({ action: "add", name: "bad-agent", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR, agentPreset: "nonexistent" });
      assert.equal(badAgent.ok, false);
      assert.match(badAgent.error, /agent preset/);
      const badPerm = await ctx.tool.execute({ action: "add", name: "bad-perm", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR, permissionPreset: "read-only" });
      assert.equal(badPerm.ok, false);
      assert.match(badPerm.error, /permission preset/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("runNow on an agent job dispatches once with a scheduler delivery", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const added = await ctx.tool.execute({ action: "add", name: "dispatch-me", cron: DORMANT_CRON, agentPrompt: "review the tree", workdir: ABS_DIR });
      assert.equal(added.ok, true);
      const run = await ctx.tool.execute({ action: "runNow", id: added.id });
      assert.equal(run.ok, true, run.error);
      await settle();
      assert.equal(ctx.dispatches.length, 1);
      const d = ctx.dispatches[0];
      assert.equal(d.kind, "scheduler");
      assert.equal(d.source, "dsh-scheduler");
      assert.ok(d.deliveryId.startsWith(added.id));
      assert.equal(typeof d.receivedAt, "number");
      assert.equal(d.event.jobId, added.id);
      assert.equal(d.event.agentPrompt, "review the tree");
      assert.equal(d.event.agentPreset, "standard");
      assert.equal(d.event.permissionPreset, "workspace-write");
      // The rule maps the delivery to a webhook-shaped Session request.
      const req = ctx.rule.run(d, new AbortController().signal);
      assert.equal(req.workspacePath, ABS_DIR);
      assert.equal(req.title, "dispatch-me");
      assert.equal(req.agentPreset, "standard");
      assert.equal(req.permissionPreset, "workspace-write");
      assert.match(req.prompt, /^\[SCHEDULED TASK\]/);
      assert.match(req.prompt, /review the tree/);
      // An agent job holds no running lock and its run record is ok.
      const snap = await ctx.tool.execute({ action: "list" });
      const job = snap.jobs.find((j) => j.id === added.id);
      assert.equal(job.running, false);
      assert.equal(job.lastRun.ok, true);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("a synchronous dispatch throw records a failed run, not a throw", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx({ failOnDispatch: true });
      const dispose = apply(ctx, {});
      await settle();
      const added = await ctx.tool.execute({ action: "add", name: "failing", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR });
      assert.equal(added.ok, true);
      const run = await ctx.tool.execute({ action: "runNow", id: added.id });
      assert.equal(run.ok, true); // runNow itself still answers ok
      await settle();
      const snap = await ctx.tool.execute({ action: "list" });
      const job = snap.jobs.find((j) => j.id === added.id);
      assert.equal(job.lastRun.ok, false);
      assert.match(job.lastRun.stderrTail, /closing/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("renderAgentPrompt frames provenance then the task", () => {
  const p = renderAgentPrompt({ name: "nightly", cron: "0 9 * * 1", agentPrompt: "check bugs" }, "manual");
  const lines = p.split("\n");
  assert.equal(lines[0], "[SCHEDULED TASK]");
  assert.ok(lines.some((l) => l === "job: nightly"));
  assert.ok(lines.some((l) => l === "cron: 0 9 * * 1"));
  assert.ok(lines.some((l) => l === "trigger: manual"));
  assert.ok(lines[lines.length - 1] === "check bugs");
});

test("a model-less agent job dispatches a lossless-JSON event (no own undefined property)", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const added = await ctx.tool.execute({ action: "add", name: "model-less", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR });
      assert.equal(added.ok, true, added.error);
      const run = await ctx.tool.execute({ action: "runNow", id: added.id });
      assert.equal(run.ok, true, run.error);
      await settle();
      assert.equal(ctx.dispatches.length, 1);
      // The exact lossless-JSON rule the real webhook runtime applies: an own
      // undefined-valued property makes the whole delivery invalid and the
      // runtime throws. The event must omit the model key entirely instead.
      assert.equal(false, "model" in ctx.dispatches[0].event);
      assert.equal(false, JSON.stringify(ctx.dispatches[0].event).includes("undefined"));
      const snap = await ctx.tool.execute({ action: "list" });
      const job = snap.jobs.find((j) => j.id === added.id);
      assert.equal(job.lastRun.ok, true);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("an async preset roster is awaited and an unknown default preset is rejected at add time", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      // The real AgentPresets list() is async: the stub must be too, or the
      // await would see a Promise and the branch would stay dead.
      ctx.webhook.agentPresets.list = async () => [{ id: "standard" }, { id: "minimal" }];
      const dispose = apply(ctx, {});
      await settle();
      const badJob = await ctx.tool.execute({ action: "add", name: "bad-async", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR, agentPreset: "nonexistent" });
      assert.equal(badJob.ok, false);
      assert.match(badJob.error, /agent preset/);
      // A config with a bogus defaultAgentPreset rejects a job that omits one.
      const ctx2 = makeCtx();
      ctx2.webhook.agentPresets.list = async () => [{ id: "standard" }];
      const configDispose = apply(ctx2, { defaultAgentPreset: "ghost-preset" });
      await settle();
      const badDefault = await ctx2.tool.execute({ action: "add", name: "bad-default", cron: DORMANT_CRON, agentPrompt: "task", workdir: ABS_DIR });
      assert.equal(badDefault.ok, false);
      assert.match(badDefault.error, /ghost-preset/);
      dispose();
      configDispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("a store job carrying both command and agentPrompt loads with command dropped (exclusivity restored)", async () => {
  await withTmp(async (dir) => {
    const storeDir = join(dir, "scheduler");
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [{
      id: "jb", name: "ambiguous", cron: DORMANT_CRON, command: "echo hi", agentPrompt: "check bugs", workdir: ABS_DIR,
      timeoutMs: null, enabled: true, createdAt: "2026-09-09T00:00:00.000Z",
      lastFiredMinute: null, running: false, runs: [],
    }] }));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const snap = await ctx.tool.execute({ action: "list" });
      const job = snap.jobs.find((j) => j.id === "jb");
      assert.ok(job);
      assert.equal(job.agentJob, true);
      assert.equal(job.command, null);
      // The shell command never runs; the agent prompt classifies the job.
      const run = await ctx.tool.execute({ action: "runNow", id: "jb" });
      assert.equal(run.ok, true);
      await settle();
      assert.equal(ctx.dispatches.length, 1);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});
