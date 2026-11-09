import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { validName } from "./names";

const execute = promisify(execFile);
export type JsonObject = Record<string, unknown>;
export interface TerminalFact { address: string; parent: string | null; labels: Record<string, string> }
export interface TabFact { space: string; id: string; name: string; terminals: Set<string> }
export interface HerdrSnapshot { core: string; terminals: Map<string, TerminalFact>; tabs: Map<string, TabFact> }

export function object(raw: unknown): JsonObject {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
	return raw as JsonObject;
}

function identifier(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(raw)) throw new Error("Invalid Herdr identifier");
	return raw;
}

function terminalMembers(root: unknown): Set<string> {
	const members = new Set<string>();
	const nodes = [root];
	let visited = 0;
	while (nodes.length) {
		if (++visited > 4096) throw new Error("Layout tree exceeds bridge limit");
		const node = object(nodes.pop());
		if (node.type === "block") {
			const content = object(node.content);
			if (content.terminal !== undefined) members.add(identifier(content.terminal));
		} else {
			if (!["row", "column", "stack"].includes(String(node.type)) || !Array.isArray(node.children)) throw new Error("Unsupported layout node");
			nodes.push(...node.children);
		}
	}
	return members;
}

export async function coreEndpoint(): Promise<string> {
	if (process.env.HC_SOCKET) {
		if (!isAbsolute(process.env.HC_SOCKET)) throw new Error("HC_SOCKET must be absolute");
		return process.env.HC_SOCKET;
	}
	const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-core/config.toml");
	if (existsSync(configPath)) {
		const config = Bun.TOML.parse(await readFile(configPath, "utf8"));
		if (config.socket !== undefined) {
			if (typeof config.socket !== "string" || !isAbsolute(config.socket)) throw new Error("Set an absolute HC_SOCKET");
			return config.socket;
		}
	}
	const session = identifier(process.env.HC_SESSION || "default");
	const runtime = process.env.XDG_RUNTIME_DIR || (existsSync(`/run/user/${process.getuid!()}`) ? `/run/user/${process.getuid!()}` : undefined);
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
	return runtime ? join(runtime, "herdr-core", `${session}.sock`) : join(state, "herdr-core", session, `${session}.sock`);
}

export async function rpc(endpoint: string, calls: { method: string; params?: JsonObject }[]): Promise<unknown[]> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
	const socket = createConnection(endpoint);
	const replies: unknown[] = [];
	let buffer = "";
	const fail = (error: Error) => { socket.destroy(); reject(error); };
	socket.setTimeout(2000, () => fail(new Error("Core request timed out")));
	socket.on("error", fail);
	socket.on("end", () => { if (Object.keys(replies).length !== calls.length) fail(new Error("Core disconnected")); });
	socket.on("connect", () => calls.forEach((call, index) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: index, ...call })}\n`)));
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		if (buffer.length > 2 * 1024 * 1024) return fail(new Error("Core reply exceeds limit"));
		try {
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const reply = object(JSON.parse(buffer.slice(0, end)));
				buffer = buffer.slice(end + 1);
				if (!Number.isInteger(reply.id) || typeof reply.id !== "number" || reply.id < 0 || reply.id >= calls.length) throw new Error("Invalid core reply ID");
				if (reply.error) throw new Error(`Core rejected request: ${JSON.stringify(reply.error)}`);
				if (Object.hasOwn(replies, reply.id)) throw new Error("Duplicate core reply");
				replies[reply.id] = reply.result;
				if (Object.keys(replies).length === calls.length) { socket.destroy(); resolve(replies); }
			}
		} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
	});
	return promise;
}

export function parseSnapshot(replies: unknown[]): HerdrSnapshot {
	const hello = object(replies[0]);
	const core = identifier(object(hello.core).id);
	if (hello.generation !== 1) throw new Error("Unsupported core protocol generation");
	const terminalList = object(replies[1]).terminals;
	const doc = object(object(replies[2]).value);
	if (!Array.isArray(terminalList) || !Array.isArray(doc.spaces)) throw new Error("Unsupported Herdr snapshot");
	const terminals = new Map<string, TerminalFact>();
	for (const rawTerminal of terminalList) {
		const terminal = object(rawTerminal);
		if (terminal.state !== "live") continue;
		if (typeof terminal.address === "string" && terminal.address.includes("/")) continue;
		const address = identifier(terminal.address);
		const labels = object(terminal.labels);
		if (Object.values(labels).some(label => typeof label !== "string")) throw new Error("Invalid terminal labels");
		terminals.set(address, { address, labels: labels as Record<string, string>, parent: terminal.parent == null ? null : identifier(terminal.parent) });
	}
	const tabs = new Map<string, TabFact>();
	for (const rawSpace of doc.spaces) {
		const space = object(rawSpace);
		const spaceId = identifier(space.id);
		if (!Array.isArray(space.tabs)) throw new Error("Invalid document tabs");
		for (const rawTab of space.tabs) {
			const tab = object(rawTab);
			const id = identifier(tab.id);
			if (tabs.has(id)) throw new Error("Duplicate tab identity");
			tabs.set(id, { space: spaceId, id, name: validName(tab.name), terminals: terminalMembers(tab.root) });
		}
	}
	return { core, terminals, tabs };
}

export async function snapshot(endpoint: string): Promise<HerdrSnapshot> {
	return parseSnapshot(await rpc(endpoint, [
		{ method: "hello", params: { generation: 1 } },
		{ method: "terminal.list" },
		{ method: "doc.get", params: { name: "herdr-app" } },
	]));
}

export function terminalTab(world: HerdrSnapshot, address: string): TabFact | undefined {
	const visited = new Set<string>();
	while (!visited.has(address)) {
		visited.add(address);
		const terminal = world.terminals.get(address);
		if (!terminal) return undefined;
		if (terminal.labels["herdr.tab"] || terminal.labels["herdr.space"]) {
			const tab = world.tabs.get(terminal.labels["herdr.tab"]);
			return tab?.space === terminal.labels["herdr.space"] && tab.terminals.has(address) ? tab : undefined;
		}
		if (!terminal.parent) return undefined;
		address = terminal.parent;
	}
	return undefined;
}

export async function appCommand(home: string, command: string, args?: JsonObject): Promise<unknown> {
	const argv = command === "ls" ? ["ls"] : ["do", command];
	if (command !== "ls" && args !== undefined) argv.push(JSON.stringify(args));
	const reply = await execute("herdr-app", argv, { env: { ...process.env, HERDR_APP_HOME: home }, timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
	const parsed = object(JSON.parse(reply.stdout));
	if (parsed.error) throw new Error(`Herdr app rejected command: ${String(parsed.error)}`);
	return parsed;
}

export async function requireAppTab(home: string, tab: TabFact): Promise<void> {
	const world = object(await appCommand(home, "ls"));
	if (!Array.isArray(world.spaces)) throw new Error("Invalid app snapshot");
	const found = world.spaces.some(rawSpace => {
		const space = object(rawSpace);
		return space.machine == null && space.id === tab.space && Array.isArray(space.tabs) && space.tabs.some(rawTab => object(rawTab).id === tab.id);
	});
	if (!found) throw new Error("Selected app window does not contain this local tab");
}
