# dsh-scheduler

A cron scheduler plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It persists cron jobs to a JSON store, fires them through the harness shell while the DSH process runs — or, for agent jobs, starts a **fresh root agent session** through the harness webhook runtime — and gives you a **Cron jobs** entry in the web GUI sidebar (stacked below *New Session*, next to the Memory button) plus a `scheduler` tool the model can call.

## Install

```sh
dsh plugin --profile web add JacopoBonta/dsh-scheduler
```

Both `JacopoBonta/dsh-scheduler` (GitHub shorthand) and `https://github.com/JacopoBonta/dsh-scheduler` work. `dsh plugin add` initializes the profile on first use, installs the package with pnpm, and appends it to the profile's `dsh.profile.bundles` layer stack automatically (the package declares `dsh.bundle`). Restart `dsh web` to load it.

## What you get

- **Sidebar entry** — a "Cron jobs" button stacked below *New Session* (mimicking the host button shape, borrowing its live classes so restyles never drift). Clicking opens a centered overlay with the job manager. In the collapsed rail it renders as a circular clock icon; if the sidebar DOM can't be found, it falls back to the sidebar foot.
- **Management overlay** — every job with its cron, next-run countdown, last-run badge (ok / exit code / timeout, hover for the output tail; click a row to expand the tail), and **run now / disable / remove** actions. An add form takes name, 5-field cron, command, an optional task prompt (agent job when filled), and an optional workdir. Agent jobs carry an `agent` badge; the expanded detail shows the prompt alongside the output tail. The view polls the snapshot API every 5s; logical failures (e.g. run-now on a running job) surface as an error line. Escape closes the overlay.
- **`scheduler` model tool** — `list | add | remove | toggle | runNow`, so an agent can manage jobs on your behalf — including scheduling future agent invocations. Because a scheduled prompt is untrusted task content, a job added through the tool cannot widen the calling session's authority: `permissionPreset` `danger-full-access` is refused (the job would fire unattended with no approval gate — add it through the Cron jobs overlay instead), and a `workdir` outside the calling session's own workspace is refused (no workspace widening or lateral movement). Adds from your own GUI/HTTP are unchanged.
- **Scheduled agent invocations** — see below.
- **Cron engine** — 5-field Vixie semantics: `*`, `*/n`, lists, ranges, and the dow wrap `5-0` (Fri–Sun). Fields are numeric only (no `mon`/`fri` names). Day-of-month OR day-of-week applies only when *both* are restricted (`0 9 * * 1` = Mondays only). `n/step` (e.g. `5/10`) is rejected — cronie has no such form, and silently narrowing it under-fires. A local wall-clock guard means each matching minute fires exactly once, including across a DST fall-back.
- **Per-job sandboxing** — each shell job runs under a `workspace-write` policy rooted at its own `workdir`; each agent invocation runs in the workdir's Web Workspace under its permission preset.
- **Persistence** — jobs live in `$DSH_HOME/scheduler/jobs.json` (atomic write, `.bak` recovery). Survives restarts; a job stuck `running` from a crash is normalized back on load. Saves are serialized (overlapping saves from jobs firing in the same minute cannot tear the store), and API mutations answer 503 until the store has loaded.
- **Missed-run catch-up** — after downtime or laptop sleep, the most recent missed occurrence (within 24h) fires once on the next tick instead of being dropped. Off with `catchUpOnStart: false` for the on-start path.
- **Request fence** — plugin API routes mirror the host's own Host/Origin checks: a DNS-rebinding `Host` or a cross-site request (`Sec-Fetch-Site: cross-site`, mismatched `Origin`) is rejected 403, so a web page you visit cannot drive the scheduler. Plain curl (no Origin header) and the same-origin GUI keep working.
- **One-time import** — set `importFrom` in the bundle patch config to import jobs from a legacy store when this plugin's own store is empty. Imports run the same validity gates `add` does: a job with an unparsable cron is skipped (it would silently never fire) and an out-of-range `timeoutMs` is dropped.

## Scheduled agent invocations

A job is a **shell job** (a `command` run through the harness shell) or an **agent job** (an `agentPrompt` — exactly one of the two). At the cron minute, an agent job hands a request to the host's `ctx.webhookRuntime`, which creates **one fresh root agent session** in the workdir's Web Workspace: the session is titled with the job name, composed from the `agentPreset`, sandboxed by the `permissionPreset`, and admitted the task prompt labeled `[SCHEDULED TASK]`. "Setup a scheduled task that checks the codebase for bugs every day at 9" is one agent-job add away.

Enable the runtime in the profile's `cordis.patch.yml` (the shipped CLI already contains `@deepseek-ai/dsh-webhook`; the overlay alone activates it):

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
```

Then restart `dsh web`. Without that row, agent-job add fails with an actionable error naming the missing row and shell jobs are untouched. Defaults: `agentPreset` `standard`, `permissionPreset` `workspace-write` (both shipped; override per job or with `defaultAgentPreset`/`defaultPermissionPreset` config).

Honest limits, inherited from the webhook runtime's fire-and-forget contract:

- The run badge means the invocation was **dispatched**, not that the agent finished — there is no completion receipt; find the created session by title in the normal session list.
- A crash between dispatch and session creation can lose one pending invocation; there is no queue or replay. The cron itself catches up missed *minutes* after downtime (one invocation per matching minute, 24h lookback).
- An unknown explicit `model` route fails the invocation and is logged by the webhook runtime.

## Configuration

In the profile's `cordis.patch.yml`, target the `dsh-scheduler` row:

```yaml
- id: dsh-scheduler
  config:
    refreshMs: 30000        # tick interval (min 5000)
    defaultTimeoutMs: 900000 # per-job timeout when a job declares none
    catchUpOnStart: true     # fire runs missed while the process was down (default true)
    defaultAgentPreset: standard       # agent-invocation preset (default standard)
    defaultPermissionPreset: workspace-write # agent-invocation permission preset (default workspace-write)
    # importFrom:            # one-time import when the store is empty
    #   - /path/to/legacy/jobs.json
```

## API

The host half serves (for the bundled client):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/dsh-scheduler/snapshot` | GET | full scheduler state (jobs, next run, last run, store path) |
| `/api/dsh-scheduler/add` | POST | add a job `{name, cron, command?, agentPrompt?, workdir?, timeoutMs?, agentPreset?, permissionPreset?, model?}` — exactly one of command/agentPrompt |
| `/api/dsh-scheduler/remove` | POST | remove a job `{id}` |
| `/api/dsh-scheduler/toggle` | POST | enable/disable a job `{id}` |
| `/api/dsh-scheduler/runNow` | POST | fire a job immediately `{id}` |

Mutations answer 503 `{ok:false, error:"scheduler still loading"}` until the store load finishes.

## License

MIT

## Development

```sh
npm test   # node --test: cron engine, request fence, store loading, body cap, agent invocations, security gates
```

The pure helpers (`parseCron`, `cronMatches`, `fenceRequest`, `readBody`, …) are exported from `lib/index.js` so the suite exercises the exact code the host runs.
