/** Security-fix behaviors: tool-path add gate, path containment, serialized saves, loaded gate, import validation. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, isPathWithin } from "../lib/index.js";

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sched-sec-test-"));
  try { return await fn(dir); } finally {
    for (let i = 0; i < 5; i++) {
      try { await rm(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
    }
  }
}

/** Minimal ctx stub with a captured webhookRuntime and an exec that mimics dsh-tools: execute(args, exec) with exec.agent.session.header.cwd. */
function makeCtx(opts = {}) {
  const ctx = {
    logger: () => ({ info() {}, error() {}, warn() {}, debug() {} }),
    emit() {},
    interval: () => () => {},
    shell: { run: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: { text: "" }, stderr: { text: "" } }) },
    webServer: { host: "127.0.0.1", register: () => () => {} },
    tools: { register: (tool) => { ctx.tool = tool; return () => {}; } },
    webhook: {
      webhookRuntime: {
        register(rule) { ctx.rule = rule; return () => {}; },
        dispatch(delivery) { ctx.dispatches.push(delivery); },
      },
      agentPresets: { list: () => [{ id: "standard" }, { id: "minimal" }] },
      permissionPresets: {
        resolve: (name) => {
          if (name !== "workspace-write" && name !== "danger-full-access") throw new Error("unknown preset " + name);
          return { sandbox: name, approval: "ask" };
        },
      },
    },
    dispatches: [],
  };
  ctx.inject = (services, cb) => cb(ctx.webhook);
  // The caller workspace the agent loop would expose: exec.agent.session.header.cwd.
  const cwd = opts.cwd === undefined ? "/Users/jacopobonta/workspace/live-portfolio" : opts.cwd;
  ctx.callerCwd = cwd;
  ctx.exec = cwd === null
    ? {}
    : { agent: { session: { header: { version: 0, id: "s1", createdAt: 0, cwd, isSeeded: false } } } };
  return ctx;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

/** A cron far in the future: the startup catch-up scan can never match it. */
const DORMANT_CRON = "0 3 29 2 1";
const CALLER_WS = "/Users/jacopobonta/workspace/live-portfolio";

// ---- isPathWithin (pure helper) ----

test("isPathWithin accepts the root itself and strict descendants", () => {
  assert.equal(isPathWithin(CALLER_WS, CALLER_WS), true);
  assert.equal(isPathWithin(CALLER_WS + "/scripts", CALLER_WS), true);
  assert.equal(isPathWithin(CALLER_WS + "/a/b/c", CALLER_WS + "/a"), true);
});

test("isPathWithin rejects siblings, prefixes, and boundary lookalikes", () => {
  assert.equal(isPathWithin("/Users/jacopobonta/workspace/other", CALLER_WS), false); // sibling
  assert.equal(isPathWithin("/Users/jacopobonta", CALLER_WS), false); // ancestor
  assert.equal(isPathWithin(CALLER_WS + "-portfolio", CALLER_WS), false); // boundary lookalike (/a/bc vs /a/b)
  assert.equal(isPathWithin("../outside", CALLER_WS), false); // .. fails closed
  assert.equal(isPathWithin("relative/path", CALLER_WS), false); // relative candidate
  assert.equal(isPathWithin(CALLER_WS, "relative"), false); // relative root
});

// ---- tool-path add gate (finding 5: unattended escalation) ----

test("tool add with permissionPreset danger-full-access is refused", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const res = await ctx.tool.execute(
        { action: "add", name: "escalate", cron: DORMANT_CRON, agentPrompt: "task", workdir: CALLER_WS, permissionPreset: "danger-full-access" },
        ctx.exec,
      );
      assert.equal(res.ok, false);
      assert.match(res.error, /danger-full-access/);
      assert.match(res.error, /GUI/);
      assert.equal(ctx.dispatches.length, 0);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("tool add with a widening defaultPermissionPreset config is refused", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, { defaultPermissionPreset: "danger-full-access" });
      await settle();
      // The job omits permissionPreset, so the default applies: refused too.
      const res = await ctx.tool.execute({ action: "add", name: "default-widen", cron: DORMANT_CRON, agentPrompt: "task", workdir: CALLER_WS }, ctx.exec);
      assert.equal(res.ok, false);
      assert.match(res.error, /danger-full-access/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("tool add with a workdir outside the caller workspace is refused", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      const outside = await ctx.tool.execute({ action: "add", name: "lateral", cron: DORMANT_CRON, command: "echo hi", workdir: "/etc" }, ctx.exec);
      assert.equal(outside.ok, false);
      assert.match(outside.error, /within the calling session's workspace/);
      const sibling = await ctx.tool.execute({ action: "add", name: "lateral2", cron: DORMANT_CRON, command: "echo hi", workdir: "/Users/jacopobonta/workspace/other" }, ctx.exec);
      assert.equal(sibling.ok, false);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("tool add inside the caller workspace still works, and a GUI add is unchanged", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      // Same-workspace add through the tool passes.
      const ok = await ctx.tool.execute({ action: "add", name: "in-workspace", cron: DORMANT_CRON, command: "echo hi", workdir: CALLER_WS }, ctx.exec);
      assert.equal(ok.ok, true, ok.error);
      // A root-session tool call (exec.agent absent — the human's own root
      // agent) has no known caller workspace: only addJob's validation applies.
      const rootExec = await ctx.tool.execute({ action: "add", name: "root-agent-add", cron: DORMANT_CRON, command: "echo hi", workdir: "/tmp" }, {});
      assert.equal(rootExec.ok, true, rootExec.error);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

// ---- serialized saves (finding 2) ----

test("overlapping saves serialize: every write lands, none tears", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      // Two same-millisecond adds fire overlapping saves; both jobs must land.
      const added = await Promise.all([
        ctx.tool.execute({ action: "add", name: "burst-a", cron: DORMANT_CRON, command: "echo a" }, ctx.exec),
        ctx.tool.execute({ action: "add", name: "burst-b", cron: DORMANT_CRON, command: "echo b" }, ctx.exec),
      ]);
      assert.equal(added[0].ok, true, added[0].error);
      assert.equal(added[1].ok, true, added[1].error);
      await new Promise((r) => setTimeout(r, 120));
      const store = JSON.parse(await readFile(join(dir, "scheduler", "jobs.json"), "utf8"));
      const names = store.jobs.map((j) => j.name).sort();
      assert.deepEqual(names, ["burst-a", "burst-b"]);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

// ---- loaded gate (finding 1) ----

test("mutations refuse while the store is still loading", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      // No settle(): apply() registered everything synchronously and the
      // async init chain (loadStore's readFile) has not resolved, so
      // state.loaded is still false — the exact window the gate protects.
      // node's readFile never resolves synchronously, so this probe is
      // deterministic.
      const res = await ctx.tool.execute({ action: "add", name: "early", cron: DORMANT_CRON, command: "true" }, ctx.exec);
      assert.equal(res.ok, false);
      assert.match(res.error, /still loading/);
      // After init completes the same add succeeds.
      await settle();
      const after = await ctx.tool.execute({ action: "add", name: "early", cron: DORMANT_CRON, command: "true" }, ctx.exec);
      assert.equal(after.ok, true, after.error);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("a suspended concurrent add loses the name race (post-await re-check)", async () => {
  await withTmp(async (dir) => {
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx();
      const dispose = apply(ctx, {});
      await settle();
      // Slow the preset roster for the FIRST add only, so it suspends inside
      // validateAgentPresets while the second add stores the name.
      let releaseSlow;
      const slowGate = new Promise((r) => { releaseSlow = r; });
      const origList = ctx.webhook.agentPresets.list;
      let slowed = false;
      ctx.webhook.agentPresets.list = () => {
        if (!slowed) { slowed = true; return slowGate.then(() => origList()); }
        return origList();
      };
      const first = ctx.tool.execute({ action: "add", name: "race", cron: DORMANT_CRON, agentPrompt: "task", workdir: CALLER_WS }, ctx.exec);
      await new Promise((r) => setTimeout(r, 10));
      const second = await ctx.tool.execute({ action: "add", name: "race", cron: DORMANT_CRON, agentPrompt: "task", workdir: CALLER_WS }, ctx.exec);
      assert.equal(second.ok, true, second.error);
      releaseSlow();
      const firstSettled = await first;
      assert.equal(firstSettled.ok, false);
      assert.match(firstSettled.error, /already exists/);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

// ---- import validation (finding 4) ----

test("import skips an invalid cron and clamps an out-of-range timeout", async () => {
  await withTmp(async (dir) => {
    const storeDir = join(dir, "scheduler");
    await mkdir(storeDir, { recursive: true });
    const legacyDir = join(dir, "legacy");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [
      { id: "l1", name: "dead-cron", cron: "99 9 * * *", command: "echo hi", enabled: true },
      { id: "l2", name: "huge-timeout", cron: DORMANT_CRON, command: "echo hi", timeoutMs: 999999999, enabled: true },
      { id: "l3", name: "negative-timeout", cron: DORMANT_CRON, command: "echo hi", timeoutMs: -5, enabled: true },
      { id: "l4", name: "fine", cron: DORMANT_CRON, command: "echo hi", timeoutMs: 5000, enabled: true },
    ] }));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx({ cwd: null });
      const dispose = apply(ctx, { importFrom: [join(legacyDir, "jobs.json")] });
      await settle();
      const snap = await ctx.tool.execute({ action: "list" }, ctx.exec);
      const names = snap.jobs.map((j) => j.name).sort();
      assert.deepEqual(names, ["fine", "huge-timeout", "negative-timeout"]); // dead-cron skipped
      const huge = snap.jobs.find((j) => j.name === "huge-timeout");
      assert.equal(huge.timeoutMs, null); // clamped out
      const neg = snap.jobs.find((j) => j.name === "negative-timeout");
      assert.equal(neg.timeoutMs, null);
      const fine = snap.jobs.find((j) => j.name === "fine");
      assert.equal(fine.timeoutMs, 5000); // in-range preserved
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("load-time normalization persists after state.jobs is assigned (no wipe)", async () => {
  await withTmp(async (dir) => {
    const storeDir = join(dir, "scheduler");
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [{
      id: "jn", name: "ambiguous", cron: DORMANT_CRON, command: "echo hi", agentPrompt: "check bugs",
      enabled: true, running: false, runs: [],
    }] }));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeCtx({ cwd: null });
      const dispose = apply(ctx, {});
      await settle();
      // The normalization (command dropped) must be persisted, and the job
      // must survive — the old rewrite-then-assign order wiped the store.
      const store = JSON.parse(await readFile(join(dir, "scheduler", "jobs.json"), "utf8"));
      assert.equal(store.jobs.length, 1);
      assert.equal(store.jobs[0].name, "ambiguous");
      assert.equal(store.jobs[0].command, null);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});
