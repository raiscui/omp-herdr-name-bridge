import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { NameBridge } from "../src/bridge";
import { querySessions } from "../src/copy-query";
import { copySocket, Registry } from "../src/registry";
import { queryRuntime } from "../src/copy-socket";

test("live copy checks membership and reads the current session, not the registry snapshot", async () => {
	const root = await mkdtemp("/tmp/obtest-");
	const bin = join(root, "bin");
	const home = join(root, "app");
	await mkdir(bin);
	await mkdir(home);
	await writeFile(join(bin, "herdr-app"), '#!/bin/sh\nexec /bin/cat "$HERDR_APP_HOME/app.json"\n', { mode: 0o700 });
	const previous = { PATH: process.env.PATH, HOME: process.env.HERDR_APP_HOME, TERMINAL: process.env.HC_TERMINAL_ID, SOCKET: process.env.HC_SOCKET };
	const core = randomUUID();
	const terminal = `t${randomUUID().replaceAll("-", "")}`;
	const target = { home, terminal, space: "space", tab: "tab", pane: "pane" };
	const endpoint = join(root, "core.sock");
	const tab = { id: "tab", name: "Same", root: { type: "block", id: "pane", content: { terminal } } };
	const terminalFact = { address: terminal, state: "live", labels: { "herdr.space": "space", "herdr.tab": "tab" }, parent: null };
	const state = { core, pid: process.pid, app: "omp" };
	const server = createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const call = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				const replies: Record<string, unknown> = {
					hello: { generation: 1, core: { id: state.core } },
					"terminal.list": { terminals: [terminalFact] },
					"doc.get": { value: { spaces: [{ id: "space", tabs: [tab] }] } },
					"terminal.get": { ...terminalFact, foreground: { pid: state.pid }, reported: true, status: { app: state.app } },
				};
				socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: call.id, result: replies[call.method] })}\n`);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, listening.resolve);
	await listening.promise;
	await writeFile(join(home, "app.json"), JSON.stringify({ spaces: [{ id: "space", machine: null, tabs: [{ id: "tab", terminals: [{ terminal, pane: "pane" }] }] }] }));
	Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, HERDR_APP_HOME: home, HC_TERMINAL_ID: terminal, HC_SOCKET: endpoint });
	let current = "session-A";
	const bridge = new NameBridge({ sessionId: () => current, getName: () => "Same", setName: async () => { throw new Error("Unexpected rename"); } });
	const peer = new Registry(core, randomUUID());
	try {
		bridge.activate();
		await bridge.startCopy();
		await bridge.synchronize();
		expect(await querySessions([target])).toEqual([{ kind: "resolved", sessionId: "session-A" }]);
		current = "session-B";
		bridge.activate();
		expect(await querySessions([target])).toEqual([{ kind: "resolved", sessionId: "session-B" }]);
		for (const wrong of [{ ...target, terminal: `remote/${terminal}` }, { ...target, tab: "other" }, { ...target, pane: "other" }, { ...target, home: root }]) {
			expect((await querySessions([wrong]))[0].kind).toBe("unavailable");
		}
		state.pid++;
		expect((await querySessions([target]))[0].kind).toBe("unavailable");
		state.pid--;
		state.app = "other";
		expect((await querySessions([target]))[0].kind).toBe("unavailable");
		state.app = "omp";
		state.core = randomUUID();
		expect((await querySessions([target]))[0].kind).toBe("unavailable");
		state.core = core;
		await peer.publish({ version: 1, runtime: peer.runtime, pid: process.pid, terminal, session: "peer", epoch: 1, heartbeat: Date.now() });
		expect((await querySessions([target]))[0].kind).toBe("unavailable");
		await peer.remove();
		expect((await querySessions([target]))[0]).toEqual({ kind: "resolved", sessionId: "session-B" });
	} finally {
		await bridge.close();
		await peer.remove();
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
		for (const [key, value] of Object.entries({ PATH: previous.PATH, HERDR_APP_HOME: previous.HOME, HC_TERMINAL_ID: previous.TERMINAL, HC_SOCKET: previous.SOCKET })) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(peer.directory, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
}, 20000);

test("an unresponsive live socket times out without returning a session", async () => {
	const core = randomUUID();
	const runtime = randomUUID();
	const peer = new Registry(core, runtime);
	const target = { home: "/tmp", space: "space", tab: "tab", pane: "pane", terminal: `t${runtime.replaceAll("-", "")}` };
	await peer.publish({ version: 1, runtime, pid: process.pid, terminal: target.terminal, session: "stale", epoch: 1, heartbeat: Date.now() });
	const server = createServer(() => undefined);
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(copySocket(runtime), listening.resolve);
	await listening.promise;
	try {
		expect((await querySessions([target]))[0].kind).toBe("unavailable");
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
		await rm(peer.directory, { recursive: true, force: true });
		await rm(copySocket(runtime), { force: true });
	}
}, 12000);

test("a forged nonce or runtime response is rejected", async () => {
	const core = randomUUID();
	const runtime = randomUUID();
	const peer = new Registry(core, runtime);
	await peer.prepare();
	const target = { home: "/tmp", space: "space", tab: "tab", pane: "pane", terminal: "twrong" };
	const server = createServer(socket => socket.on("data", () => socket.end(`${JSON.stringify({
		nonce: randomUUID(), identity: { core, runtime, pid: process.pid, epoch: 1 },
		result: { kind: "resolved", sessionId: "wrong" },
	})}\n`)));
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(copySocket(runtime), listening.resolve);
	await listening.promise;
	try {
		await expect(queryRuntime(target, { core, runtime, pid: process.pid }, "resolve")).rejects.toThrow();
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(closed.resolve);
		await closed.promise;
		await rm(peer.directory, { recursive: true, force: true });
		await rm(copySocket(runtime), { force: true });
	}
});
