import { mkdir, lstat, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
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

async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) {
		throw new Error(`Bridge registry must be a private owned directory: ${path}`);
	}
}

export class Registry {
	readonly directory: string;
	readonly path: string;
	constructor(core: string, readonly runtime: string) {
		this.directory = join("/tmp", `omp-herdr-name-bridge-${process.getuid!()}`, core);
		this.path = join(this.directory, `${runtime}.json`);
	}
	async publish(record: Registration): Promise<void> {
		await privateDirectory(join(this.directory, ".."));
		await privateDirectory(this.directory);
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
	async remove(): Promise<void> { await unlink(this.path).catch(ignoreMissing); }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
	if (error.code !== "ENOENT") throw error;
}
