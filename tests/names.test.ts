import { describe, expect, test } from "bun:test";
import { nameDecision, validName, type NameBaseline } from "../src/names";
import { parseSnapshot, terminalTab } from "../src/herdr";

const baseline: NameBaseline = { binding: "core/tab/1", omp: "first", tab: "first" };
const current = (omp: string, tab: string) => ({ binding: baseline.binding, omp, tab });

describe("bidirectional names", () => {
	test("existing OMP name wins the initial association", () => {
		expect(nameDecision(undefined, current("existing", "tab title"), 0)).toEqual({ kind: "renameTab", name: "existing" });
	});
	test("unnamed OMP waits rather than importing positional names", () => {
		expect(nameDecision(undefined, current("", "1"), 0)).toEqual({ kind: "waiting" });
	});
	test("OMP rename and automatic name changes update the tab", () => {
		expect(nameDecision(baseline, current("new", "first"), 0)).toEqual({ kind: "renameTab", name: "new" });
	});
	test("tab rename updates OMP", () => {
		expect(nameDecision(baseline, current("first", "new"), 0)).toEqual({ kind: "renameOmp", name: "new", baseline: { ...current("first", "new"), manualTab: true } });
	});
	test("equal names never issue another rename", () => {
		expect(nameDecision(baseline, current("first", "first"), 0).kind).toBe("settled");
	});
	test("a manual tab rename wins simultaneous changes and keeps ownership", () => {
		const decision = nameDecision(baseline, current("omp", "tab"), 0);
		expect(decision).toEqual({ kind: "renameOmp", name: "tab", baseline: { ...current("omp", "tab"), manualTab: true } });
		if (decision.kind !== "renameOmp") throw new Error("Expected a manual tab rename");
		const owned = { ...decision.baseline, omp: "tab" };
		expect(nameDecision(owned, current("later OMP title", "tab"), 1)).toEqual({
			kind: "settled", baseline: { ...current("later OMP title", "tab"), manualTab: true },
		});
	});
	test("clearing a tab also prevents later OMP names from restoring it", () => {
		const cleared = current("first", "");
		const owned = { ...cleared, manualTab: true as const };
		expect(nameDecision(baseline, cleared, 0)).toEqual({ kind: "settled", baseline: owned });
		expect(nameDecision(owned, current("later", ""), 0)).toEqual({
			kind: "settled", baseline: { ...current("later", ""), manualTab: true },
		});
	});
	test("pending app writes cannot echo an old tab name into OMP", () => {
		const pending = { ...current("new", "first"), pendingTab: { before: "first", target: "new", until: 5000 } };
		expect(nameDecision(pending, current("new", "first"), 1000).kind).toBe("waiting");
		expect(nameDecision(pending, current("new", "first"), 5001)).toEqual({ kind: "renameTab", name: "new" });
		expect(nameDecision(pending, current("new", "user override"), 1000)).toEqual({
			kind: "renameOmp", name: "user override", baseline: { ...current("new", "user override"), manualTab: true },
		});
	});
	test("a session switch establishes a new initial priority", () => {
		expect(nameDecision(baseline, { ...current("new session", "first"), binding: "core/tab/2" }, 0)).toEqual({ kind: "renameTab", name: "new session" });
	});
	test("an automatic tab acknowledgement does not claim manual ownership", () => {
		const pending = { ...current("new", "first"), pendingTab: { before: "first", target: "new", until: 5000 } };
		const acknowledged = nameDecision(pending, current("new", "new"), 1000);
		expect(acknowledged).toEqual({ kind: "settled", baseline: current("new", "new") });
		expect(nameDecision(current("new", "new"), current("later", "new"), 2000)).toEqual({ kind: "renameTab", name: "later" });
	});
	test("name boundary rejects control characters and oversized text", () => {
		expect(() => validName("bad\nname")).toThrow();
		expect(() => validName("x".repeat(4097))).toThrow();
		expect(validName(" 中文 name ")).toBe("中文 name");
	});
});

function wireSnapshot() {
	return [{ generation: 1, core: { id: "core" } }, { terminals: [
		{ address: "t1", state: "live", parent: null, labels: { "herdr.tab": "tab", "herdr.space": "space" } },
		{ address: "t2", state: "live", parent: "t1", labels: {} },
	] }, { value: { spaces: [{ id: "space", tabs: [{ id: "tab", name: "", root: { type: "row", children: [{ type: "block", content: { terminal: "t1" } }] } }] }] }, version: 1 }];
}

test("core labels and parent association use raw empty names, not numbers or cwd", () => {
	const world = parseSnapshot(wireSnapshot());
	expect(terminalTab(world, "t1")).toEqual({ id: "tab", space: "space", name: "", terminals: new Set(["t1"]) });
	expect(terminalTab(world, "t2")?.id).toBe("tab");
	expect(terminalTab(world, "t9")).toBeUndefined();
});

test("unknown layout shape fails closed", () => {
	expect(() => parseSnapshot([{ generation: 1, core: { id: "core" } }, { terminals: [] }, { value: null }])).toThrow();
});

test("relocation pauses while labels and document membership disagree", () => {
	const world = parseSnapshot(wireSnapshot());
	world.terminals.get("t1")!.labels["herdr.tab"] = "elsewhere";
	expect(terminalTab(world, "t1")).toBeUndefined();
	world.terminals.get("t1")!.labels["herdr.tab"] = "tab";
	world.tabs.get("tab")!.terminals.clear();
	expect(terminalTab(world, "t1")).toBeUndefined();
});
