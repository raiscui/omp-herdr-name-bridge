import { expect, mock, test } from "bun:test";

let rows: { app: string; address: string; space: string; tab: string; pane: string }[] = [];
let answer: unknown;
const notices: unknown[] = [];
const clipboard: string[] = [];
let click: ((event: unknown, cx: unknown) => void) | undefined;
const element = {
	id() { return this; }, flex_none() { return this; }, p() { return this; }, rounded() { return this; },
	text_color() { return this; }, cursor_pointer() { return this; }, hover() { return this; },
	tooltip() { return this; }, child() { return this; }, size() { return this; },
	on_click(handler: typeof click) { click = handler; return this; },
};
mock.module("gpui-kit", () => ({ div: () => element, svg: () => element }));
mock.module("herdr", () => ({
	agents: () => rows,
	appHome: () => "/tmp/copy-ui-test",
	exec: async (_command: string, args: string[]) => {
		const request = JSON.parse(args[1]);
		return { code: 0, stdout: JSON.stringify(request.mode === "availability" ? request.targets.map(() => true) : answer), stderr: "" };
	},
	notify: (notice: unknown) => notices.push(notice),
}));
Object.assign(globalThis, { BUN_PATH: "/test/bun", QUERY_PATH: "/test/query" });
// The native host modules must be mocked before loading the mod.
const { CopySessions } = await import("../scripts/copy-session.js");

function context() {
	const jobs: Promise<unknown>[] = [];
	const cx = {
		notify() {},
		write_to_clipboard(text: string) { clipboard.push(text); },
		spawn(body: (context: unknown) => Promise<unknown>) { jobs.push(body(cx)); },
	};
	return { cx, jobs };
}

const agent = (index: number) => ({ app: "omp", address: `t${index}`, space: "space", tab: `tab${index}`, pane: `pane${index}` });

test("available copy buttons survive a complete scan of 80 OMP rows", async () => {
	const originalNow = Date.now;
	let now = originalNow();
	Date.now = () => now;
	rows = Array.from({ length: 80 }, (_, index) => agent(index));
	const sessions = new CopySessions();
	const { cx, jobs } = context();
	try {
		for (let batch = 0; batch < 5; batch++) {
			sessions.refresh(cx);
			await jobs.pop();
			now += 10000;
		}
		expect(rows.every(row => sessions.available(row))).toBe(true);
		rows[0] = { ...rows[0], app: "other" };
		expect(sessions.available(rows[0])).toBe(false);
	} finally {
		sessions.close();
		Date.now = originalNow;
	}
});

test("copy click resolves a fresh ID, stops bubbling, and leaves clipboard untouched on failure", async () => {
	rows = [agent(1)];
	const sessions = new CopySessions();
	const { cx, jobs } = context();
	let stopped = 0;
	const eventContext = { ...cx, stop_propagation() { stopped++; } };
	try {
		sessions.button(rows[0], { dim: "dim", hover: "hover", foreground: "foreground" });
		answer = { kind: "resolved", sessionId: "new-current-session" };
		click!({}, eventContext);
		await jobs.pop();
		expect(stopped).toBe(1);
		expect(clipboard).toEqual(["new-current-session"]);
		expect(notices.at(-1)).toEqual({ title: "Copied OMP session ID", level: "success" });
		answer = { kind: "unavailable", reason: "changed" };
		click!({}, eventContext);
		await jobs.pop();
		expect(clipboard).toEqual(["new-current-session"]);
		expect(notices.at(-1)).toEqual({ title: "Could not copy OMP session ID", level: "warning" });
	} finally {
		sessions.close();
	}
});
