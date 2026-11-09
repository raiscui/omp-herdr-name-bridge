import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { appCommand, object, rpc, snapshot, terminalTab } from "../src/herdr";

const execute = promisify(execFile);
const root = await mkdtemp("/tmp/ocui-");
const endpoint = join(root, "core.sock");
const home = join(root, "app");
const hc = Bun.which("hc");
const omp = Bun.which("omp");
const app = process.env.HERDR_TEST_APP || "/Applications/Herdr.app/Contents/MacOS/Herdr";
assert(hc && omp, "Install hc and omp before running this fixture");
const bun = join(dirname(omp), "bun");
const env = {
	PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
	TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"), HC_SOCKET: endpoint, HC_SESSION: "copy-ui-fixture",
	HERDR_APP_HOME: home, OMP_HERDR_BRIDGE_REGISTRY: join(root, "registry"), HERDR_TELEMETRY: "0", DO_NOT_TRACK: "1",
	PI_CODING_AGENT_DIR: join(root, "omp"), OPENAI_API_KEY: "isolated-fixture-no-network",
};
Object.assign(process.env, env);
delete process.env.HC_TERMINAL_ID;
for (const path of [home, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR, env.PI_CODING_AGENT_DIR]) await mkdir(path, { recursive: true });
await writeFile(join(home, "settings.json"), JSON.stringify({ core: hc, telemetry: false }));
await writeFile(join(env.PI_CODING_AGENT_DIR, "config.yml"), "title:\n  icons: boring\nsetupVersion: 3\n");
let appProcess: Bun.Subprocess | undefined;
const terminals = new Set<string>();

async function until<T>(label: string, read: () => Promise<T | undefined>, timeout = 30000): Promise<T> {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try { const value = await read(); if (value !== undefined) return value; } catch (error) { lastError = error; }
		await Bun.sleep(200);
	}
	throw new Error(`${label} timed out: ${String(lastError || "")}`);
}

try {
	await execute(hc, ["server", "start"], { env, timeout: 10000 });
	appProcess = Bun.spawn([app], { env, stdout: Bun.file(join(root, "app.stdout.log")), stderr: Bun.file(join(root, "app.stderr.log")) });
	await until("isolated app", async () => { await appCommand(home, "ls"); return true; });
	await execute(bun, [resolve(import.meta.dir, "install-copy.ts")], { env, timeout: 45000 });
	await appCommand(home, "space.new", { name: "Copy UI fixture", tab: "Copy fixture", folder: root, machine: "", argv: [bun, omp,
		"--model", "openai/gpt-4.1", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-tools", "--no-lsp", "--no-title",
		"--cwd", root, "--session-dir", join(root, "sessions"), "-e", resolve(import.meta.dir, "../src/index.ts")] });
	const target = await until("OMP foreground and exact app target", async () => {
		const world = await snapshot(endpoint);
		for (const address of world.terminals.keys()) terminals.add(address);
		const tab = [...world.tabs.values()].find(entry => entry.name === "Copy fixture");
		if (!tab) return undefined;
		const address = [...world.terminals.keys()].find(candidate => terminalTab(world, candidate)?.id === tab.id);
		if (!address) return undefined;
		terminals.add(address);
		const fact = object((await rpc(endpoint, [{ method: "terminal.get", params: { terminal: address } }]))[0]);
		if (fact.reported !== true || object(fact.status).app !== "omp" || !object(fact.foreground).pid) return undefined;
		const list = object(await appCommand(home, "ls"));
		const space = (list.spaces as unknown[]).map(object).find(entry => entry.id === tab.space && entry.machine === null);
		const selectedTab = (space?.tabs as unknown[] | undefined)?.map(object).find(entry => entry.id === tab.id);
		const pane = (selectedTab?.terminals as unknown[] | undefined)?.map(object).find(entry => entry.terminal === address)?.pane;
		if (typeof pane !== "string") return undefined;
		return { home, space: tab.space, tab: tab.id, pane, terminal: address };
	});
	const evidence = await until("live OMP session query", async () => {
		const reply = await execute(bun, [resolve(import.meta.dir, "copy-query.ts"), JSON.stringify({ mode: "resolve", targets: [target] })], { env, timeout: 8000 });
		const answer = object(JSON.parse(reply.stdout));
		if (answer.kind !== "resolved") return undefined;
		const fact = object((await rpc(endpoint, [{ method: "terminal.get", params: { terminal: target.terminal } }]))[0]);
		return { target, sessionId: answer.sessionId, foreground: object(fact.foreground).pid, core: (await snapshot(endpoint)).core };
	});
	await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	await execute("herdr-app", ["shot", join(root, "fixture.png")], { env, timeout: 10000 });
	console.log(`READY ${root}\n${JSON.stringify(evidence)}\nIsolated app and real OMP remain running. Press Enter to stop only these processes.`);
	const input = createInterface({ input: process.stdin });
	const stopped = Promise.withResolvers<void>();
	input.once("line", stopped.resolve);
	input.once("close", stopped.resolve);
	await stopped.promise;
	input.close();
} catch (error) {
	console.error(`Fixture artifacts: ${root}`);
	try {
		const world = await snapshot(endpoint);
		for (const address of world.terminals.keys()) terminals.add(address);
	} catch (diagnosticError) { console.error("Unable to list isolated terminals", diagnosticError); }
	for (const address of terminals) {
		for (const command of ["get", "read"]) {
			try {
				const result = await execute(hc, [command, address], { env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
				await writeFile(join(root, `${address}.${command}.log`), result.stdout + result.stderr);
				console.error(`hc ${command} ${address}:\n${result.stdout}${result.stderr}`);
			} catch (diagnosticError) { console.error(`hc ${command} ${address} failed`, diagnosticError); }
		}
	}
	throw error;
} finally {
	for (const address of terminals) {
		await execute(hc, ["keep", address, "--off"], { env, timeout: 10000 }).catch(console.error);
		await execute(hc, ["kill", address], { env, timeout: 10000 }).catch(console.error);
	}
	if (appProcess) await appCommand(home, "app.quit").catch(console.error);
	await execute(hc, ["server", "stop"], { env, timeout: 10000 }).catch(console.error);
}
