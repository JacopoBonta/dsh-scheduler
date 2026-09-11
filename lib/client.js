window.__ModuleLoader__.load({
  id: "dsh-scheduler",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useRef, useCallback } = react;
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch { reactDom = null; }

    const inject = ["slots"];

    // --- inline icon set (one weight, no emoji) ---
    function ClockSvg(props) {
      const size = props && props.size ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 12, cy: 12, r: 9, stroke: "currentColor", strokeWidth: 1.6 }),
        h("path", { d: "M12 7v5l3.2 2", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
    }

    function ago(ts) {
      if (!ts) return "";
      const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
      if (s < 60) return s + "s ago";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m ago";
      const hr = Math.round(m / 60);
      if (hr < 48) return hr + "h ago";
      return Math.round(hr / 24) + "d ago";
    }

    function rel(iso) {
      if (!iso) return null;
      const ms = new Date(iso).getTime() - Date.now();
      const mins = Math.round(Math.abs(ms) / 60000);
      const txt = mins < 60 ? mins + "m" : (mins < 1440 ? Math.round(mins / 60) + "h" : Math.round(mins / 1440) + "d");
      return ms >= 0 ? "in " + txt : txt + " ago";
    }

    // --- stylesheet, host data-plugin-css convention, token palette only ---
    const CSS_TAG = "dsh-scheduler/scheduler.css";
    const css = [
      ".dsh-sched-topentry{display:contents}",
      ".dsh-sched-topentry-native{width:100%;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);text-align:left}",
      ".dsh-sched-topentry-native:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sched-topentry-native .dsh-sched-topentry-label{white-space:nowrap}",
      ".dsh-sched-trigger{background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary);width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;flex:none}",
      ".dsh-sched-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sched-backdrop{position:fixed;inset:0;z-index:999;background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);backdrop-filter:blur(2px);animation:dsh-sched-fadein .14s ease-out}",
      ".dsh-sched-overlay{position:fixed;z-index:1000;left:50%;top:50%;transform:translate(-50%,-50%);width:min(880px,calc(100vw - 88px));height:min(720px,calc(100vh - 64px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);animation:dsh-sched-pop .18s cubic-bezier(.2,.9,.3,1)}",
      "@keyframes dsh-sched-fadein{from{opacity:0}to{opacity:1}}",
      "@keyframes dsh-sched-pop{from{opacity:0;transform:translate(-50%,-48%) scale(.98)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}",
      ".dsh-sched-overlaybar{flex:none;display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 12px 0 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sched-overlaytitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}",
      ".dsh-sched-overlaybody{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dsh-sched-x{background:none;border:none;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary);width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1}",
      ".dsh-sched-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-sched-app{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".dsh-sched-pad{flex:1;min-height:0;overflow-y:auto;padding:14px 18px}",
      ".dsh-sched-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}",
      ".dsh-sched-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}",
      ".dsh-sched-store{margin-left:auto}",
      ".dsh-sched-jobs{border-top:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sched-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".dsh-sched-row.dsh-sched-off{opacity:.55}",
      ".dsh-sched-name{font-weight:600;font-size:13px}",
      ".dsh-sched-cron{color:var(--dsw-alias-label-secondary)}",
      ".dsh-sched-next{color:var(--dsw-alias-label-tertiary)}",
      ".dsh-sched-badge{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;padding:1px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
      ".dsh-sched-badge.dsh-sched-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".dsh-sched-badge.dsh-sched-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".dsh-sched-badge.dsh-sched-run{color:var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-primary));border-color:var(--dsw-alias-state-warning-primary, var(--dsw-alias-border-l1));animation:dsh-sched-pulse 1.4s ease-in-out infinite}",
      ".dsh-sched-badge.dsh-sched-agent{color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary));border-color:var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l1))}",
      "@keyframes dsh-sched-pulse{50%{opacity:.4}}",
      ".dsh-sched-badge.dsh-sched-off{opacity:.5}",
      ".dsh-sched-actions{margin-left:auto;display:flex;gap:6px}",
      ".dsh-sched-btn{font:inherit;font-size:11px;padding:3px 10px;border-radius:6px;cursor:pointer;background:none;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-sched-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-sched-btn:disabled{opacity:.4;cursor:default}",
      ".dsh-sched-form{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:12px}",
      ".dsh-sched-input{font:inherit;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:none;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 9px}",
      ".dsh-sched-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l1))}",
      ".dsh-sched-err{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".dsh-sched-empty{color:var(--dsw-alias-label-tertiary);padding:16px 2px}",
      ".dsh-sched-detail{width:100%;padding:2px 2px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto}",
      "@media (prefers-reduced-motion:reduce){.dsh-sched-overlay{animation:none}.dsh-sched-backdrop{animation:none}.dsh-sched-badge.dsh-sched-run{animation:none}}",
    ].join("\n");
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-scheduler";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // --- API (native fetch + timers: static client modules are not sandboxed) ---
    function getSnapshot() {
      return fetch("/api/dsh-scheduler/snapshot", { headers: { Accept: "application/json" } })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    }
    function post(action, body) {
      return fetch("/api/dsh-scheduler/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    }

    // --- shared management UI (overlay body) ---
    function RunBadge(props) {
      const r = props.job;
      if (r.running) return h("span", { className: "dsh-sched-badge dsh-sched-run" }, "running…");
      if (!r.lastRun) return h("span", { className: "dsh-sched-badge dsh-sched-off" }, "never run");
      const cls = r.lastRun.ok ? "dsh-sched-badge dsh-sched-ok" : "dsh-sched-badge dsh-sched-fail";
      const label = (r.lastRun.ok ? "ok" : (r.lastRun.timedOut ? "timeout" : "exit " + (r.lastRun.exitCode === null ? "?" : r.lastRun.exitCode))) + " · " + ago(r.lastRun.startedAt);
      return h("span", { className: cls, title: (r.lastRun.stderrTail || r.lastRun.stdoutTail || "").slice(0, 600) }, label);
    }

    function Row(props) {
      const job = props.job;
      const busy = job.running;
      const last = job.lastRun;
      // An agent job shows its prompt even before its first run, when the
      // prompt is the only detail there is; the renderer below handles both.
      const showDetail = props.expanded && (last || job.agentPrompt);
      return h("div", { className: "dsh-sched-row" + (job.enabled ? "" : " dsh-sched-off"), onClick: props.onToggle },
        h("span", { className: "dsh-sched-name" }, job.name),
        job.agentJob ? h("span", { className: "dsh-sched-badge dsh-sched-agent", title: "agent job — starts one fresh root session at the cron minute" }, "agent") : null,
        h("span", { className: "dsh-sched-mono dsh-sched-cron" }, job.cron + (job.cronValid ? "" : " (invalid)")),
        job.nextRun ? h("span", { className: "dsh-sched-next", title: job.nextRun }, "next " + rel(job.nextRun)) : null,
        h(RunBadge, { job }),
        h("span", { className: "dsh-sched-actions" },
          h("button", { className: "dsh-sched-btn", disabled: busy, onClick: (e) => { e.stopPropagation(); props.act("runNow", job); } }, "run now"),
          h("button", { className: "dsh-sched-btn", onClick: (e) => { e.stopPropagation(); props.act("toggle", job) } }, job.enabled ? "disable" : "enable"),
          h("button", { className: "dsh-sched-btn", disabled: busy, onClick: (e) => { e.stopPropagation(); props.act("remove", job); } }, "remove"),
        ),
        showDetail ? h("div", { className: "dsh-sched-detail" }, (job.agentPrompt ? "prompt: " + job.agentPrompt + "\n" : "") + ((last && (last.stderrTail || last.stdoutTail)) || "").slice(0, 1500)) : null,
      );
    }

    function AddForm(props) {
      const st = props.st;
      const set = props.set;
      const field = (key, placeholder) => h("input", {
        className: "dsh-sched-input",
        placeholder: key + " — " + placeholder,
        value: st[key] || "",
        onChange: (e) => { const next = Object.assign({}, st); next[key] = e.target.value; set(next); },
      });
      const isAgent = !!(st.agentPrompt || "").trim();
      return h("div", { className: "dsh-sched-form" },
        field("name", "weekly-codebase-check"),
        field("cron", "0 9 * * 1 (Mondays 09:00)"),
        field("command", isAgent ? "optional for agent jobs" : "node scripts/update.mjs --push"),
        field("agentPrompt", isAgent ? "task — starts one fresh agent session in workdir" : "task — fills this to make it an agent job"),
        field("workdir", "/absolute/path/to/project (required for agent jobs)"),
        h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { className: "dsh-sched-btn", disabled: props.busy, onClick: props.submit }, isAgent ? "add agent job" : "add job"),
          h("button", { className: "dsh-sched-btn", onClick: props.cancel }, "cancel"),
        ),
      );
    }

    function SchedulerApp() {
      const snapState = useState(null);
      const snap = snapState[0], setSnap = snapState[1];
      const errState = useState(null);
      const err = errState[0], setErr = errState[1];
      const formState = useState(null);
      const form = formState[0], setForm = formState[1];
      const expandedState = useState(null);
      const expanded = expandedState[0], setExpanded = expandedState[1];
      const formRef = useRef(null);

      const refresh = useCallback(() => {
        return getSnapshot().then((s) => { setSnap(s); setErr(null); })
          .catch((e) => setErr(String(e && e.message ? e.message : e)));
      }, []);

      useEffect(() => {
        let alive = true;
        refresh();
        const timer = setInterval(() => { if (alive) refresh(); }, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);

      const act = (action, job) => {
        post(action, { id: job.id }).then((res) => {
          // Mutations answer HTTP 200 with {ok:false} on logical failures
          // (already running, unknown id): surface them, don't swallow.
          if (res && res.ok === false) setErr(res.error || "action failed");
          else setErr(null);
          return refresh();
        }).catch((e) => setErr(String(e && e.message ? e.message : e)));
      };

      const submit = () => {
        if (!formRef.current) return;
        post("add", formRef.current).then((res) => {
          if (res && res.ok) { setForm(null); } else { setErr(res && res.error ? res.error : "add failed"); }
          refresh();
        }).catch((e) => setErr(String(e && e.message ? e.message : e)));
      };
      formRef.current = form;

      if (err && !snap) return h("div", { className: "dsh-sched-app" }, h("div", { className: "dsh-sched-pad" }, h("div", { className: "dsh-sched-err" }, "scheduler error: " + err)));
      if (!snap) return h("div", { className: "dsh-sched-app" }, h("div", { className: "dsh-sched-pad" }, h("div", { className: "dsh-sched-empty" }, "loading scheduler…")));
      const jobs = snap.jobs || [];
      return h("div", { className: "dsh-sched-app" },
        h("div", { className: "dsh-sched-pad" },
          h("div", { className: "dsh-sched-meta" },
            h("span", null, jobs.length + " job(s) · " + snap.firedCount + " fired since start"),
            h("span", { className: "dsh-sched-mono" }, snap.lastTickAt ? "tick " + ago(snap.lastTickAt) : ""),
            h("button", { className: "dsh-sched-btn", onClick: () => setForm(form ? null : { name: "", cron: "", command: "", agentPrompt: "", workdir: "" }) }, form ? "close" : "+ add job"),
            h("span", { className: "dsh-sched-mono dsh-sched-store", title: snap.storePath }, snap.storePath),
          ),
          form ? h(AddForm, { st: form, set: setForm, busy: false, cancel: () => setForm(null), submit }) : null,
          err ? h("div", { className: "dsh-sched-err" }, err) : null,
          jobs.length === 0 && !form
            ? h("div", { className: "dsh-sched-empty" }, "no jobs scheduled — add one with “+ add job”")
            : h("div", { className: "dsh-sched-jobs" }, jobs.map((job) => h(Row, {
                key: job.id, job, act,
                expanded: expanded === job.id,
                onToggle: () => setExpanded(expanded === job.id ? null : job.id),
              }))),
        ),
      );
    }

    function Overlay(props) {
      // Escape-to-close: declared before the early return (rules-of-hooks) and
      // only wired while open; a fixed overlay must also answer the keyboard.
      const open = props.open;
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === "Escape") props.onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open, props.onClose]);
      if (!open) return null;
      const tree = h("div", null,
        h("div", { className: "dsh-sched-backdrop", onClick: props.onClose }),
        h("div", { className: "dsh-sched-overlay", role: "dialog", "aria-label": "Cron jobs", "aria-modal": "true" },
          h("div", { className: "dsh-sched-overlaybar" },
            h("span", { className: "dsh-sched-overlaytitle" }, h(ClockSvg, { size: 16 }), "Cron jobs"),
            h("button", { className: "dsh-sched-x", "aria-label": "Close cron jobs", onClick: props.onClose }, "×"),
          ),
          h("div", { className: "dsh-sched-overlaybody" }, h(SchedulerApp)),
        ),
      );
      // Portal to body (mneme's pattern): a fixed overlay rendered inside the
      // sidebar can be clipped by transformed ancestors.
      if (reactDom && typeof document !== "undefined") return reactDom.createPortal(tree, document.body);
      return tree;
    }

    // --- sidebar entry: registered in sidebar.footer.action as anchor, real
    // button portaled below "New session" (mneme's verified pattern) ---
    function SidebarFallbackTrigger(props) {
      const setOpen = props.setOpen;
      return h("button", {
        type: "button",
        className: "dsh-sched-trigger",
        "aria-label": "Cron jobs",
        title: "Cron jobs",
        onClick: () => setOpen(true),
      }, h(ClockSvg, { size: props.wide ? 16 : 18 }));
    }

    function SidebarTopEntry(props) {
      const setOpen = props.setOpen;
      const wide = props.wide;
      const hostState = useState(null);
      const host = hostState[0], setHost = hostState[1];
      const nativeClsState = useState("");
      const nativeCls = nativeClsState[0], setNativeCls = nativeClsState[1];
      useEffect(() => {
        if (!reactDom || typeof document === "undefined") return undefined;
        let tries = 0, timer = null, created = null, mo = null;
        const findNative = (region) =>
          region.parentElement.querySelector('[class*="newSession"]')
          || region.previousElementSibling;
        const attempt = () => {
          const region = document.querySelector('[class*="regionArea"]');
          if (region && region.parentElement) {
            created = document.createElement("div");
            created.dataset.pluginEntry = "dsh-scheduler";
            region.parentElement.insertBefore(created, region);
            setHost(created);
            setNativeCls(findNative(region)?.className || "");
            mo = new MutationObserver(() => {
              const cur = document.querySelector('[class*="regionArea"]');
              if (!cur || !cur.parentElement) return;
              const cls = findNative(cur)?.className || "";
              setNativeCls((prev) => (prev === cls ? prev : cls));
            });
            mo.observe(region.parentElement, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
            return;
          }
          if (++tries > 40) return; // give up the portal, footer fallback stays usable
          timer = setTimeout(attempt, 50);
        };
        attempt();
        return () => {
          clearTimeout(timer);
          if (mo) mo.disconnect();
          if (created && created.parentElement) created.parentElement.removeChild(created);
        };
      }, []);
      if (!host) return h(SidebarFallbackTrigger, props);
      // display:contents wrapper — the button becomes a direct child of the
      // sidebar flex layout, a sibling of "New session" with native spacing,
      // borrowing the host button's live className (zero drift on restyles).
      return reactDom.createPortal(
        h("div", { className: "dsh-sched-topentry", style: { display: "contents" } },
          h("button", {
            type: "button",
            className: (nativeCls + " dsh-sched-topentry-native").trim(),
            "aria-label": "Cron jobs",
            title: "Cron jobs",
            onClick: () => setOpen(true),
          }, h(ClockSvg, { size: wide ? 15 : 18 }), wide && h("span", { className: "dsh-sched-topentry-label" }, "Cron jobs")),
        ), host);
    }

    function apply(ctx) {
      // No hooks here: apply() is a plain setup function, not a React
      // component — the hook dispatcher is null at apply time (the exact
      // "Cannot read properties of null (reading 'useRef')" crash). All
      // state lives in the slot component below.
      ctx.slots.inject("sidebar.footer.action", () => {
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-scheduler",
          order: 10,
          label: "Cron jobs",
        }, (props) => {
          const wide = !!(props && props.wide);
          const openState = useState(false);
          const open = openState[0], setOpen = openState[1];
          return h(react.Fragment, null,
            h(SidebarTopEntry, { wide, setOpen }),
            h(Overlay, { open, onClose: () => setOpen(false) }),
          );
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
