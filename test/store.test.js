/** Store loading: stuck-running normalization via the live apply() init chain. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sched-test-"));
  try { return await fn(dir); } finally {
    // A fired job's async saveStore can still be mid-write when the test
    // returns; retry so the cleanup never races it.
    for (let i = 0; i < 5; i++) {
      try { await rm(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
    }
  }
}

/** Minimal ctx stub: shell.run records calls and hangs until `release()` — so a run is genuinely in flight. */
function makeCtx(calls) {
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const ctx = {
    logger: () => ({ info() {}, error() {}, warn() {}, debug() {} }),
    emit() {},
    interval: () => () => {},
    shell: {
      run: async (spec) => {
        calls.runs.push(spec);
        await gate;
        return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: "" }, stderr: { text: "" } };
      },
    },
    webServer: { host: "127.0.0.1", register: () => () => {} },
    tools: { register: (tool) => { ctx.tool = tool; ctx.releaseShell = release; return () => {}; } },
  };
  return ctx;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

const writeStore = async (dir, jobs) => {
  const storeDir = join(dir, "scheduler");
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, "jobs.json"), JSON.stringify({ version: 1, jobs }));
};

/** A cron far in the future: the startup catch-up scan can never match it, so tests see only their own fireJob calls. */
const DORMANT_CRON = "0 3 29 2 1"; // Feb 29, 03:00, Monday — rare enough

test("store with stuck running:true loads normalized (job can fire again after a crash)", async () => {
  await withTmp(async (dir) => {
    await writeStore(dir, [{
      id: "jx", name: "stuck", cron: DORMANT_CRON, command: "true", workdir: null,
      timeoutMs: null, enabled: true, createdAt: "2026-09-09T00:00:00.000Z",
      lastFiredMinute: null, running: true, runs: [],
    }]);
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const calls = { runs: [] };
      const ctx = makeCtx(calls);
      const dispose = apply(ctx, {});
      await settle();
      // Old behavior refused forever with "already running"; the normalized
      // load lets runNow start the job.
      const result = await ctx.tool.execute({ action: "runNow", id: "jx" });
      assert.equal(result.ok, true);
      await settle();
      assert.equal(calls.runs.length, 1);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("runNow while genuinely running refuses", async () => {
  await withTmp(async (dir) => {
    await writeStore(dir, [{
      id: "jy", name: "double", cron: DORMANT_CRON, command: "true", workdir: null,
      timeoutMs: null, enabled: true, createdAt: "2026-09-09T00:00:00.000Z",
      lastFiredMinute: null, running: false, runs: [],
    }]);
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const calls = { runs: [] };
      const ctx = makeCtx(calls);
      const dispose = apply(ctx, {});
      await settle();
      const first = await ctx.tool.execute({ action: "runNow", id: "jy" });
      assert.equal(first.ok, true);
      await settle(); // let the gated shell.run enter flight
      const second = await ctx.tool.execute({ action: "runNow", id: "jy" });
      assert.equal(second.ok, false);
      assert.match(second.error, /already running/);
      ctx.releaseShell(); // let the run finish so cleanup can proceed
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});

test("removeJob works once a stuck running flag is normalized", async () => {
  await withTmp(async (dir) => {
    await writeStore(dir, [{
      id: "jz", name: "zombie", cron: DORMANT_CRON, command: "true", workdir: null,
      timeoutMs: null, enabled: true, createdAt: "2026-09-09T00:00:00.000Z",
      lastFiredMinute: null, running: true, runs: [],
    }]);
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const calls = { runs: [] };
      const ctx = makeCtx(calls);
      const dispose = apply(ctx, {});
      await settle();
      const result = await ctx.tool.execute({ action: "remove", id: "jz" });
      assert.equal(result.ok, true);
      dispose();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    }
  });
});
