# dsh-scheduler

A cron scheduler plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It persists cron jobs to a JSON store, fires them through the harness shell while the DSH process runs, and gives you a **Cron jobs** entry in the web GUI sidebar (stacked below *New Session*, next to the Memory button) plus a `scheduler` tool the model can call.

## Install

```sh
dsh plugin --profile web add JacopoBonta/dsh-scheduler
```

Both `JacopoBonta/dsh-scheduler` (GitHub shorthand) and `https://github.com/JacopoBonta/dsh-scheduler` work. `dsh plugin add` initializes the profile on first use, installs the package with pnpm, and appends it to the profile's `dsh.profile.bundles` layer stack automatically (the package declares `dsh.bundle`). Restart `dsh web` to load it.

## What you get

- **Sidebar entry** — a "Cron jobs" button stacked below *New Session* (mimicking the host button shape, borrowing its live classes so restyles never drift). Clicking opens a centered overlay with the job manager. In the collapsed rail it renders as a circular clock icon; if the sidebar DOM can't be found, it falls back to the sidebar foot.
- **Management overlay** — every job with its cron, next-run countdown, last-run badge (ok / exit code / timeout, hover for the output tail; click a row to expand the tail), and **run now / disable / remove** actions. An add form takes name, 5-field cron, command, and an optional workdir. The view polls the snapshot API every 5s; logical failures (e.g. run-now on a running job) surface as an error line. Escape closes the overlay.
- **`scheduler` model tool** — `list | add | remove | toggle | runNow`, so an agent can manage jobs on your behalf.
- **Cron engine** — 5-field Vixie semantics: `*`, `*/n`, lists, ranges, and the dow wrap `5-0` (Fri–Sun). Fields are numeric only (no `mon`/`fri` names). Day-of-month OR day-of-week applies only when *both* are restricted (`0 9 * * 1` = Mondays only). `n/step` (e.g. `5/10`) is rejected — cronie has no such form, and silently narrowing it under-fires. A local wall-clock guard means each matching minute fires exactly once, including across a DST fall-back.
- **Per-job sandboxing** — each job runs under a `workspace-write` policy rooted at its own `workdir`.
- **Persistence** — jobs live in `$DSH_HOME/scheduler/jobs.json` (atomic write, `.bak` recovery). Survives restarts; a job stuck `running` from a crash is normalized back on load.
- **Missed-run catch-up** — after downtime or laptop sleep, the most recent missed occurrence (within 24h) fires once on the next tick instead of being dropped. Off with `catchUpOnStart: false` for the on-start path.
- **Request fence** — plugin API routes mirror the host's own Host/Origin checks: a DNS-rebinding `Host` or a cross-site request (`Sec-Fetch-Site: cross-site`, mismatched `Origin`) is rejected 403, so a web page you visit cannot drive the scheduler. Plain curl (no Origin header) and the same-origin GUI keep working.
- **One-time import** — set `importFrom` in the bundle patch config to import jobs from a legacy store when this plugin's own store is empty.

## Configuration

In the profile's `cordis.patch.yml`, target the `dsh-scheduler` row:

```yaml
- id: dsh-scheduler
  config:
    refreshMs: 30000        # tick interval (min 5000)
    defaultTimeoutMs: 900000 # per-job timeout when a job declares none
    catchUpOnStart: true     # fire runs missed while the process was down (default true)
    # importFrom:            # one-time import when the store is empty
    #   - /path/to/legacy/jobs.json
```

## API

The host half serves (for the bundled client):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/dsh-scheduler/snapshot` | GET | full scheduler state (jobs, next run, last run, store path) |
| `/api/dsh-scheduler/add` | POST | add a job `{name, cron, command, workdir?, timeoutMs?}` |
| `/api/dsh-scheduler/remove` | POST | remove a job `{id}` |
| `/api/dsh-scheduler/toggle` | POST | enable/disable a job `{id}` |
| `/api/dsh-scheduler/runNow` | POST | fire a job immediately `{id}` |

## License

MIT

## Development

```sh
npm test   # node --test: cron engine, request fence, store loading, body cap
```

The pure helpers (`parseCron`, `cronMatches`, `fenceRequest`, `readBody`, …) are exported from `lib/index.js` so the suite exercises the exact code the host runs.
