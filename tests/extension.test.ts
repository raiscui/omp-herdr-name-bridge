import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import herdrNameBridge from "../src/index";
import { rpc } from "../src/herdr";

test("ordinary OMP outside Herdr does not register work or start core", () => {
	const terminal = process.env.HC_TERMINAL_ID;
	delete process.env.HC_TERMINAL_ID;
	try {
		const registrations: string[] = [];
		herdrNameBridge({ on: (event: string) => registrations.push(event) } as unknown as ExtensionAPI);
		expect(registrations).toEqual([]);
	} finally {
		if (terminal === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = terminal;
	}
});

test("a missing Herdr socket rejects without launching a core", async () => {
	await expect(rpc(`/tmp/no-herdr-${randomUUID()}.sock`, [{ method: "hello" }])).rejects.toThrow();
});
