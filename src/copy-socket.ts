import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { copySocket, registryRoot } from "./registry";
import { localTarget, runtimeIdentity, sessionId, type CopyResult, type LocalTarget, type RuntimeIdentity } from "./copy-types";
import { object } from "./herdr";

interface Request {
	nonce: string;
	target: LocalTarget;
	mode: "availability" | "resolve";
	identity: Omit<RuntimeIdentity, "epoch">;
}

type Reply = { nonce: string; identity: RuntimeIdentity; result: CopyResult };

function request(raw: unknown): Request {
	const input = object(raw);
	const identity = object(input.identity);
	if (typeof input.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(input.nonce)) throw new Error("Invalid nonce");
	if (input.mode !== "availability" && input.mode !== "resolve") throw new Error("Invalid copy query mode");
	const parsed = runtimeIdentity({ ...identity, epoch: 1 });
	return { nonce: input.nonce, mode: input.mode, target: localTarget(input.target), identity: { core: parsed.core, runtime: parsed.runtime, pid: parsed.pid } };
}

export class CopyServer {
	private server?: Server;
	private starting?: Promise<void>;
	private stopped = false;
	private sockets = new Set<Socket>();

	constructor(private runtime: string, private resolve: (request: Request) => Promise<RuntimeIdentity & CopyResult>) {}

	start(): Promise<void> {
		if (this.stopped || this.server) return Promise.resolve();
		if (!this.starting) this.starting = this.listen().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	private async listen(): Promise<void> {
		await mkdir(registryRoot, { recursive: true, mode: 0o700 });
		const stat = await lstat(registryRoot);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error("Bridge registry is not private");
		if (this.stopped) return;
		const server = createServer(socket => this.accept(socket));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("error", reject);
		server.listen(copySocket(this.runtime), () => { server.off("error", reject); resolve(); });
		await promise;
		this.server = server;
		server.on("error", () => { void this.close(); });
		await chmod(copySocket(this.runtime), 0o600);
	}

	private accept(socket: Socket): void {
		if (this.stopped || this.sockets.size >= 32) { socket.destroy(); return; }
		this.sockets.add(socket);
		const timeout = setTimeout(() => socket.destroy(), 6000);
		socket.once("close", () => { clearTimeout(timeout); this.sockets.delete(socket); });
		socket.on("error", () => socket.destroy());
		let buffer = "";
		let received = false;
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			if (buffer.length > 8192 || (received && chunk.length)) { socket.destroy(); return; }
			if (!buffer.includes("\n")) return;
			received = true;
			void this.respond(socket, buffer.slice(0, buffer.indexOf("\n")));
		});
	}

	private async respond(socket: Socket, line: string): Promise<void> {
		try {
			const parsed = request(JSON.parse(line));
			const { core, runtime, pid, epoch, ...result } = await this.resolve(parsed);
			if (!this.stopped && !socket.destroyed) socket.end(`${JSON.stringify({ nonce: parsed.nonce, identity: { core, runtime, pid, epoch }, result })}\n`);
		} catch { socket.destroy(); }
	}

	async close(): Promise<void> {
		this.stopped = true;
		try { await this.starting; } catch {}
		for (const socket of this.sockets) socket.destroy();
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
		await unlink(copySocket(this.runtime)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
	}
}

export async function queryRuntime(target: LocalTarget, identity: Omit<RuntimeIdentity, "epoch">, mode: "availability" | "resolve"): Promise<Reply> {
	const nonce = randomUUID();
	const socket = createConnection(copySocket(identity.runtime));
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	let buffer = "";
	const timeout = setTimeout(() => fail(new Error("Copy request timed out")), 5500);
	const fail = (error: Error) => { clearTimeout(timeout); socket.destroy(); reject(error); };
	socket.on("error", fail);
	socket.on("end", () => fail(new Error("Copy host disconnected")));
	socket.setEncoding("utf8");
	socket.on("connect", () => socket.write(`${JSON.stringify({ nonce, target, identity, mode })}\n`));
	socket.on("data", chunk => {
		buffer += chunk;
		if (buffer.length > 8192) return fail(new Error("Copy response exceeds limit"));
		if (!buffer.includes("\n")) return;
		try {
			const response = object(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
			const actual = runtimeIdentity(response.identity);
			const rawResult = object(response.result);
			if (response.nonce !== nonce || actual.core !== identity.core || actual.runtime !== identity.runtime || actual.pid !== identity.pid) throw new Error("Copy response identity mismatch");
			const result: CopyResult = rawResult.kind === "resolved" ? { kind: "resolved", sessionId: sessionId(rawResult.sessionId) }
				: rawResult.kind === "unavailable" && typeof rawResult.reason === "string" ? { kind: "unavailable", reason: rawResult.reason }
				: (() => { throw new Error("Invalid copy response"); })();
			clearTimeout(timeout);
			socket.destroy();
			resolve({ nonce, identity: actual, result });
		} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
	});
	return promise;
}
