import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Registry, type Registration } from "../src/registry";
import type { HerdrSnapshot } from "../src/herdr";

function world(core: string): HerdrSnapshot {
	return { core, terminals: new Map([["t1", { address: "t1", parent: null, labels: { "herdr.tab": "tab", "herdr.space": "space" } }]]),
		tabs: new Map([["tab", { id: "tab", space: "space", name: "original", terminals: new Set(["t1"]) }]]) };
}

function record(runtime: string): Registration {
	return { version: 1, runtime, pid: process.pid, terminal: "t1", session: "same-session", epoch: 1, heartbeat: Date.now() };
}

test("two runtime owners of the same session pause and cleanup resumes", async () => {
	const core = randomUUID();
	const first = new Registry(core, randomUUID());
	const second = new Registry(core, randomUUID());
	try {
		await first.publish(record(first.runtime));
		expect(await first.unique(world(core), record(first.runtime))).toBe(true);
		await second.publish(record(second.runtime));
		expect(await first.unique(world(core), record(first.runtime))).toBe(false);
		expect(await second.unique(world(core), record(second.runtime))).toBe(false);
		await second.remove();
		expect(await first.unique(world(core), record(first.runtime))).toBe(true);
	} finally { await rm(first.directory, { recursive: true, force: true }); }
});

test("a stale but living process pauses instead of expiring into uniqueness", async () => {
	const core = randomUUID();
	const first = new Registry(core, randomUUID());
	const second = new Registry(core, randomUUID());
	try {
		await first.publish(record(first.runtime));
		await second.publish({ ...record(second.runtime), heartbeat: Date.now() - 10000 });
		expect(await first.unique(world(core), record(first.runtime))).toBe(false);
	} finally { await rm(first.directory, { recursive: true, force: true }); }
});

test("unknown and malformed registrations fail closed", async () => {
	const core = randomUUID();
	const first = new Registry(core, randomUUID());
	try {
		await first.publish(record(first.runtime));
		await writeFile(join(first.directory, "corrupt.json"), "{}");
		await expect(first.unique(world(core), record(first.runtime))).rejects.toThrow();
	} finally { await rm(first.directory, { recursive: true, force: true }); }
});

test("a demonstrably exited owner's registration is removed", async () => {
	const core = randomUUID();
	const first = new Registry(core, randomUUID());
	const exited = new Registry(core, randomUUID());
	const child = Bun.spawn(["/usr/bin/true"]);
	await child.exited;
	try {
		await first.publish(record(first.runtime));
		await exited.publish({ ...record(exited.runtime), pid: child.pid });
		expect(await first.unique(world(core), record(first.runtime))).toBe(true);
	} finally { await rm(first.directory, { recursive: true, force: true }); }
});

test("manual tab ownership survives runtime cleanup and is scoped to the core and tab", async () => {
	const core = randomUUID();
	const first = new Registry(core, randomUUID());
	const restarted = new Registry(core, randomUUID());
	const other = new Registry(randomUUID(), randomUUID());
	try {
		await first.publish(record(first.runtime));
		expect(await first.manualTab("tab")).toBe(false);
		await first.claimTab("tab");
		await first.remove();
		await restarted.publish(record(restarted.runtime));
		expect(await restarted.manualTab("tab")).toBe(true);
		expect(await restarted.manualTab("other-tab")).toBe(false);
		await other.publish(record(other.runtime));
		expect(await other.manualTab("tab")).toBe(false);
		expect(await restarted.unique(world(core), record(restarted.runtime))).toBe(true);
	} finally {
		await rm(first.directory, { recursive: true, force: true });
		await rm(other.directory, { recursive: true, force: true });
	}
});
