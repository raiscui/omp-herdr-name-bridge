import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appCommand, object, snapshot, terminalTab, type HerdrSnapshot, type JsonObject } from "../src/herdr";
import { Registry } from "../src/registry";

const execute = promisify(execFile);
const root = await mkdtemp("/tmp/onb-");
const endpoint = join(root, "core.sock");
const home = join(root, "app");
const hc = Bun.which("hc");
const omp = Bun.which("omp");
const app = process.env.HERDR_TEST_APP || "/Applications/Herdr.app/Contents/MacOS/Herdr";
assert(hc && omp, "Install hc and omp before running verification");
const environment: Record<string, string> = {
	PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
	TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"), HC_SOCKET: endpoint, HC_SESSION: "bridge-verification",
	HERDR_APP_HOME: home, HERDR_TELEMETRY: "0", DO_NOT_TRACK: "1", CI: "1",
	OPENAI_API_KEY: "isolated-verification-no-network",
	PI_CODING_AGENT_DIR: join(root, "omp"), BRIDGE_TEST_INITIAL: "Existing OMP",
};
Object.assign(process.env, environment);
delete process.env.HC_TERMINAL_ID;
for (const directory of [home, environment.TMPDIR, environment.XDG_CONFIG_HOME, environment.XDG_STATE_HOME, environment.XDG_RUNTIME_DIR]) await mkdir(directory, { recursive: true });
await writeFile(join(home, "settings.json"), JSON.stringify({ core: hc, telemetry: false }));
for (const index of [1, 2]) {
	const agentDir = join(root, `omp-${index}`);
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "config.yml"), "title:\n  icons: boring\n");
}
const clients: OmpClient[] = [];
let appProcess: Bun.Subprocess | undefined;
let registryDirectory: string | undefined;

async function closeApp(): Promise<void> {
	if (!appProcess || appProcess.exitCode !== null) return;
	try { await appCommand(home, "app.quit"); } catch { appProcess.kill(); }
	const timeout = setTimeout(() => appProcess?.kill(), 5000);
	try { await appProcess.exited; } finally { clearTimeout(timeout); }
}

async function until(label: string, predicate: () => Promise<boolean>, timeout = 20000): Promise<void> {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try { if (await predicate()) { console.log(`PASS ${label}`); return; } }
		catch (error) { lastError = error; }
		await Bun.sleep(100);
	}
	throw new Error(`${label} did not converge. ${String(lastError || "")}`);
}

class OmpClient {
	readonly process;
	readonly errors: Promise<string>;
	private promptResults = new Map<string, JsonObject>();
	private pending = new Map<string, { resolve: (reply: JsonObject) => void; reject: (error: Error) => void }>();
	private sequence = 0;
	constructor(terminal: string, initial: string, index: number) {
		this.process = Bun.spawn([omp!, "--model", "openai/gpt-4.1", "--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-tools", "--no-lsp", "--no-title", "--cwd", root,
			"--session-dir", join(root, `sessions-${index}`), "-e", resolve(import.meta.dir, "naming-fixture.ts"), "-e", resolve(import.meta.dir, "../src/index.ts")], {
			env: { ...environment, HC_TERMINAL_ID: terminal, BRIDGE_TEST_INITIAL: initial, PI_CODING_AGENT_DIR: join(root, `omp-${index}`) }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
		});
		this.errors = new Response(this.process.stderr).text();
		void this.readReplies();
		clients.push(this);
	}
	private async readReplies(): Promise<void> {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of this.process.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				if (!line.trim()) continue;
				const reply = object(JSON.parse(line));
				if (typeof reply.id !== "string") continue;
				if (reply.type === "prompt_result") {
					this.promptResults.set(reply.id, reply);
					continue;
				}
				if (reply.type !== "response") continue;
				const pending = this.pending.get(reply.id);
				this.pending.delete(reply.id);
				if (reply.success === false) pending?.reject(new Error(JSON.stringify(reply)));
				else pending?.resolve(reply);
			}
		}
		for (const pending of this.pending.values()) pending.reject(new Error(`OMP exited. ${await this.errors}`));
	}
	async command(type: string, args: JsonObject = {}): Promise<JsonObject> {
		const id = String(++this.sequence);
		const { promise, resolve, reject } = Promise.withResolvers<JsonObject>();
		this.pending.set(id, { resolve, reject });
		this.process.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
		const timer = setTimeout(() => reject(new Error(`OMP command timed out: ${type}`)), 30000);
		try { return await promise; } finally { clearTimeout(timer); this.pending.delete(id); }
	}
	async name(): Promise<string> { return String(object((await this.command("get_state")).data).sessionName || ""); }
	async local(command: string): Promise<void> {
		const reply = await this.command("prompt", { message: command });
		if (reply.data !== undefined) {
			assert.equal(object(reply.data).agentInvoked, false, "Verification must never invoke a model");
			return;
		}
		const id = String(this.sequence);
		await until("local command result", async () => this.promptResults.has(id));
		const result = this.promptResults.get(id)!;
		this.promptResults.delete(id);
		assert.equal(result.agentInvoked, false, "Verification must never invoke a model");
		assert.equal(result.status, "completed");
	}
	async close(): Promise<void> {
		this.process.stdin.end();
		const timeout = setTimeout(() => this.process.kill(), 10000);
		try { await this.process.exited; } finally { clearTimeout(timeout); }
	}
}

try {
	await execute(hc, ["server", "start"], { env: environment, timeout: 10000 });
	appProcess = Bun.spawn([app], { env: environment, stdout: Bun.file(join(root, "app.stdout.log")), stderr: Bun.file(join(root, "app.stderr.log")) });
	await until("isolated app control socket", async () => { await appCommand(home, "ls"); return true; });
	await appCommand(home, "space.new", { name: "Bridge verification", tab: "Original tab", folder: root, argv: ["/bin/cat"], machine: "" });
	let world: HerdrSnapshot;
	await until("isolated tab persisted", async () => {
		world = await snapshot(endpoint);
		return [...world.tabs.values()].some(tab => tab.name === "Original tab");
	});
	const createdTab = [...world!.tabs.values()].find(tab => tab.name === "Original tab");
	assert(createdTab, "Isolated app must create the requested tab");
	const terminal = [...world.terminals.keys()].find(address => terminalTab(world, address)?.id === createdTab.id);
	assert(terminal, "Isolated tab must have a live terminal");
	registryDirectory = new Registry(world.core, "unused").directory;
	const first = new OmpClient(terminal, "Existing OMP", 1);
	await first.command("get_state");
	const tabName = async () => (await snapshot(endpoint)).tabs.get(createdTab.id)?.name;
	const evidence: Record<string, { omp: string; tab: string | undefined }> = {};
	const names = async (stage: string) => {
		evidence[stage] = { omp: await first.name(), tab: await tabName() };
		console.log(`NAMES ${stage} ${JSON.stringify(evidence[stage])}`);
		await writeFile(join(root, "names.json"), JSON.stringify(evidence, null, 2));
	};
	await until("initial OMP name wins", async () => await tabName() === "Existing OMP");
	await names("initial");
	await first.local("/bridge-test-auto Automatic title");
	await until("automatic OMP title reaches tab", async () => await tabName() === "Automatic title");
	await names("automatic");
	await first.local("/rename User OMP rename");
	await until("OMP /rename reaches tab", async () => await tabName() === "User OMP rename");
	await names("omp-to-tab");
	await closeApp();
	await first.local("/rename Offline OMP rename");
	await Bun.sleep(1500);
	assert.equal(await tabName(), "User OMP rename", "Missing app must pause without writing the core document");
	appProcess = Bun.spawn([app], { env: environment, stdout: Bun.file(join(root, "app-reconnect.stdout.log")), stderr: Bun.file(join(root, "app-reconnect.stderr.log")) });
	await until("app reconnect preserves pending OMP rename", async () => await tabName() === "Offline OMP rename");
	await names("before-tab-rename");
	await appCommand(home, "tab.rename", { id: createdTab.id, name: "User tab rename" });
	await until("tab rename reaches exact OMP", async () => await first.name() === "User tab rename");
	await names("tab-to-omp");
	await appCommand(home, "tab.rename", { id: createdTab.id, name: "Second tab rename" });
	await until("successive tab rename reaches exact OMP", async () => await first.name() === "Second tab rename");
	await names("second-tab-to-omp");
	await first.local("/bridge-test-stable");
	assert.equal(await first.name(), "Second tab rename");
	assert.equal(await tabName(), "Second tab rename");
	console.log("PASS equal-name loop prevention");
	const second = new OmpClient(terminal, "Second OMP", 2);
	await second.command("get_state");
	await until("two runtime registrations", async () => (await readdir(registryDirectory!)).filter(name => name.endsWith(".json")).length === 2);
	await appCommand(home, "tab.rename", { id: createdTab.id, name: "Paused tab" });
	await Bun.sleep(2300);
	assert.equal(await first.name(), "Second tab rename");
	assert.equal(await second.name(), "Second OMP");
	assert.equal(await tabName(), "Paused tab");
	console.log("PASS multiple OMP instances pause both directions");
	await second.close();
	await until("multi-session cleanup and resume preserves baseline", async () => await first.name() === "Paused tab");
	await appCommand(home, "tab.rename", { id: createdTab.id, name: "" });
	await Bun.sleep(1500);
	assert.equal(await first.name(), "Paused tab");
	assert.equal(await tabName(), "");
	console.log("PASS automatic numbering never becomes an OMP rename");
	await first.command("new_session");
	await first.local("/rename Switched session");
	await until("session switch rebinds", async () => await tabName() === "Switched session");
	await first.close();
	await until("shutdown removes owned registration", async () => (await readdir(registryDirectory!)).every(name => !name.endsWith(".json")));
	console.log(`PASS real core/app/OMP naming paths. Scratch evidence ${root}`);
} catch (error) {
	console.error(error);
	console.error(`Scratch evidence ${root}`);
	try { console.error(await readFile(join(root, "app.stderr.log"), "utf8")); } catch {}
	process.exitCode = 1;
} finally {
	for (const client of clients) if (client.process.exitCode === null) await client.close();
	await closeApp();
	await execute(hc, ["server", "stop"], { env: environment, timeout: 10000 }).catch(error => { console.error("Isolated core cleanup failed", error); process.exitCode = 1; });
	if (registryDirectory) await rm(registryDirectory, { recursive: true, force: true });
}
