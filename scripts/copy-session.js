import { div, svg } from "gpui-kit";
import { agents, appHome, exec, notify } from "herdr";

const targetFor = (agent) => {
  if (agent.app !== "omp" || !/^t[a-zA-Z0-9]+$/.test(agent.address) || !agent.space || !agent.tab || !agent.pane
      || [agent.space, agent.tab, agent.pane].some(id => id.includes("/"))) return null;
  return { home: appHome(), space: agent.space, tab: agent.tab, pane: agent.pane, terminal: agent.address };
};
const keyOf = (target) => JSON.stringify(target);

const POLL_MS = 4000;
const QUERY_TIMEOUT_MS = 7500;
const BATCH_SIZE = 16;

export class CopySessions {
  constructor() {
    this.availableUntil = new Map();
    this.busy = new Set();
    this.polling = false;
    this.closed = false;
    this.offset = 0;
  }

  start(cx) {
    this.timer = cx.timer.every(POLL_MS, (timerCx) => this.refresh(timerCx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.closed || this.polling) return;
    const targets = agents().map(targetFor).filter(Boolean);
    const live = new Set(targets.map(keyOf));
    for (const [key, until] of this.availableUntil) if (!live.has(key) || until <= Date.now()) this.availableUntil.delete(key);
    if (!targets.length) { cx.notify(); return; }
    const count = Math.min(BATCH_SIZE, targets.length);
    const lifetime = Math.max(15000, Math.ceil(targets.length / count) * (POLL_MS + QUERY_TIMEOUT_MS));
    const batch = Array.from({ length: count }, (_, i) => targets[(this.offset + i) % targets.length]);
    this.offset = (this.offset + count) % targets.length;
    this.polling = true;
    cx.spawn(async (taskCx) => {
      try {
        const response = await exec(BUN_PATH, [QUERY_PATH, JSON.stringify({ mode: "availability", targets: batch })], { timeout: QUERY_TIMEOUT_MS });
        const flags = response.code === 0 ? JSON.parse(response.stdout) : null;
        if (!Array.isArray(flags) || flags.length !== batch.length || flags.some(flag => typeof flag !== "boolean")) throw new Error("Invalid availability response");
        if (this.closed) return;
        const current = new Set(agents().map(targetFor).filter(Boolean).map(keyOf));
        batch.forEach((target, index) => {
          const key = keyOf(target);
          if (flags[index] && current.has(key)) this.availableUntil.set(key, Date.now() + lifetime);
          else this.availableUntil.delete(key);
        });
      } catch {
        for (const target of batch) this.availableUntil.delete(keyOf(target));
      } finally {
        this.polling = false;
        if (!this.closed) taskCx.notify();
      }
    });
  }

  available(agent) {
    const target = targetFor(agent);
    return !!target && (this.availableUntil.get(keyOf(target)) ?? 0) > Date.now();
  }

  button(agent, theme) {
    const target = targetFor(agent);
    return div().id(`copy-session-${agent.address}`).flex_none().p(2).rounded(4).text_color(theme.dim).cursor_pointer()
      .hover(el => el.bg(theme.hover).text_color(theme.foreground)).tooltip("Copy OMP session ID")
      .on_click((_event, cx) => {
        cx.stop_propagation();
        if (!target || this.closed) return;
        const key = keyOf(target);
        if (this.busy.has(key)) return;
        this.busy.add(key);
        cx.spawn(async (taskCx) => {
          try {
            const response = await exec(BUN_PATH, [QUERY_PATH, JSON.stringify({ mode: "resolve", targets: [target] })], { timeout: QUERY_TIMEOUT_MS });
            const answer = response.code === 0 ? JSON.parse(response.stdout) : null;
            const current = agents().some(candidate => {
              const next = targetFor(candidate);
              return next && keyOf(next) === key;
            });
            if (this.closed) return;
            if (!current || answer?.kind !== "resolved" || typeof answer.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(answer.sessionId)) throw new Error("Session unavailable");
            taskCx.write_to_clipboard(answer.sessionId);
            notify({ title: "Copied OMP session ID", level: "success" });
          } catch {
            if (!this.closed) {
              this.availableUntil.delete(key);
              notify({ title: "Could not copy OMP session ID", level: "warning" });
            }
          } finally {
            this.busy.delete(key);
            if (!this.closed) taskCx.notify();
          }
        });
      })
      .child(svg("mods/omp-agents/copy.svg").size(13));
  }

  close() {
    this.closed = true;
    this.timer?.cancel();
    this.availableUntil.clear();
    this.busy.clear();
  }
}
