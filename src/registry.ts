import { mkdir, lstat, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { object, terminalTab, type HerdrSnapshot } from "./herdr";

export interface Registration {
	version: 1;
	runtime: string;
	pid: number;
	terminal: string;
	session: string;
	epoch: number;
	heartbeat: number;
}

function registration(raw: unknown): Registration {
	const record = object(raw);
	if (record.version !== 1 || typeof record.runtime !== "string" || !/^[a-f0-9-]{36}$/.test(record.runtime)
		|| !Number.isInteger(record.pid) || Number(record.pid) < 1 || typeof record.terminal !== "string"
		|| !/^t[a-zA-Z0-9]+$/.test(record.terminal) || typeof record.session !== "string" || !record.session
		|| !Number.isInteger(record.epoch) || Number(record.epoch) < 1 || typeof record.heartbeat !== "number"
		|| !Number.isFinite(record.heartbeat)) throw new Error("Invalid bridge registration; synchronization paused");
	return record as unknown as Registration;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export const registryRoot = process.env.OMP_HERDR_BRIDGE_REGISTRY || join("/tmp", `omp-herdr-name-bridge-${process.getuid!()}`);
if (!isAbsolute(registryRoot)) throw new Error("Bridge registry path must be absolute");

async function requirePrivateDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) {
		throw new Error(`Bridge registry must be a private owned directory: ${path}`);
	}
}

async function records(directory: string): Promise<Registration[]> {
	const peers: Registration[] = [];
	for (const filename of await readdir(directory)) {
		if (!filename.endsWith(".json")) continue;
		let raw: string;
		try { raw = await readFile(join(directory, filename), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		const peer = registration(JSON.parse(raw));
		if (filename !== `${peer.runtime}.json`) throw new Error("Registration identity mismatch");
		if (alive(peer.pid)) peers.push(peer);
	}
	return peers;
}

export async function copyCandidates(terminals: Set<string>): Promise<{ core: string; registration: Registration }[]> {
	try { await requirePrivateDirectory(registryRoot); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const candidates: { core: string; registration: Registration }[] = [];
	for (const entry of await readdir(registryRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(entry.name) || entry.name === "." || entry.name === "..") throw new Error("Invalid core registry identity");
		const directory = join(registryRoot, entry.name);
		await requirePrivateDirectory(directory);
		for (const peer of await records(directory)) {
			if (terminals.has(peer.terminal)) candidates.push({ core: entry.name, registration: peer });
		}
	}
	return candidates;
}

export function copySocket(runtime: string): string {
	if (!/^[a-f0-9-]{36}$/.test(runtime)) throw new Error("Invalid bridge runtime");
	const path = join(registryRoot, `s-${runtime}`);
	if (Buffer.byteLength(path) >= 104) throw new Error("Bridge socket path is too long");
	return path;
}

async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await requirePrivateDirectory(path);
}

export class Registry {
	readonly directory: string;
	readonly path: string;
	constructor(core: string, readonly runtime: string) {
		this.directory = join(registryRoot, core);
		this.path = join(this.directory, `${runtime}.json`);
	}
	async prepare(): Promise<void> {
		await privateDirectory(registryRoot);
		await privateDirectory(this.directory);
	}
	async publish(record: Registration): Promise<void> {
		await this.prepare();
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
		await rename(temporary, this.path);
	}
	async unique(world: HerdrSnapshot, own: Registration): Promise<boolean> {
		const tab = terminalTab(world, own.terminal);
		if (!tab) return false;
		let occupants = 0;
		for (const filename of await readdir(this.directory)) {
			if (!filename.endsWith(".json")) continue;
			const path = join(this.directory, filename);
			let raw: string;
			try { raw = await readFile(path, "utf8"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
			const peer = registration(JSON.parse(raw));
			if (filename !== `${peer.runtime}.json`) throw new Error("Registration identity mismatch");
			if (!alive(peer.pid)) { await unlink(path).catch(ignoreMissing); continue; }
			const peerTab = terminalTab(world, peer.terminal);
			if (!peerTab || Date.now() - peer.heartbeat > 8000 || peer.heartbeat > Date.now() + 5000) return false;
			if (peerTab.id === tab.id) {
				occupants++;
				if (peer.runtime !== own.runtime) return false;
			}
		}
		return occupants === 1;
	}
	async uniqueTerminal(own: Registration): Promise<boolean> {
		await requirePrivateDirectory(registryRoot);
		await requirePrivateDirectory(this.directory);
		const peers = (await records(this.directory)).filter(peer => peer.terminal === own.terminal);
		return peers.length === 1 && peers[0].runtime === own.runtime && peers[0].pid === own.pid
			&& Date.now() - peers[0].heartbeat <= 8000 && peers[0].heartbeat <= Date.now() + 5000;
	}
	async manualTab(tab: string): Promise<boolean> {
		try {
			const ownership = await readFile(join(this.directory, `${tab}.manual`), "utf8");
			if (ownership !== "1") throw new Error("Invalid manual tab ownership record");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	async claimTab(tab: string): Promise<void> {
		await writeFile(join(this.directory, `${tab}.manual`), "1", { mode: 0o600 });
	}
	async remove(): Promise<void> { await unlink(this.path).catch(ignoreMissing); }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
	if (error.code !== "ENOENT") throw error;
}
