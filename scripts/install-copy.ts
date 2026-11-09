import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { appCommand } from "../src/herdr";

const execute = promisify(execFile);
const home = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
const mod = join(home, "mods/omp-agents");
const layout = join(home, "layouts/omp-main.json");
const source = resolve(import.meta.dir, "copy-session.js");
const query = resolve(import.meta.dir, "copy-query.ts");
if (!isAbsolute(home) || !isAbsolute(process.execPath)) throw new Error("App home and Bun executable must be absolute");

async function absent(path: string): Promise<void> {
	try { await lstat(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	throw new Error(`Refusing to overwrite existing personal file: ${path}`);
}

function replaceOnce(text: string, anchor: string, replacement: string): string {
	const index = text.indexOf(anchor);
	if (index < 0 || text.indexOf(anchor, index + anchor.length) >= 0) throw new Error(`Unsupported shipped agents or layout: ${anchor}`);
	return text.slice(0, index) + replacement + text.slice(index + anchor.length);
}

function patchedAgents(text: string): string {
	text = replaceOnce(text, 'import { View, div, image, svg } from "gpui-kit";', 'import { View, div, image, svg } from "gpui-kit";\nimport { CopySessions } from "./copy-session.js";');
	text = replaceOnce(text, '    if (props()?.sortMenu) return;\n    this.folded = new Set();', '    if (props()?.sortMenu) return;\n    this.copySessions = new CopySessions();\n    this.copySessions.start(cx);\n    this.folded = new Set();');
	text = replaceOnce(text, '        .when(this.hovered === a.address, el => el.child(pin))', '        .when(this.hovered === a.address && this.copySessions.available(a), el => el.child(this.copySessions.button(a, t)))\n        .when(this.hovered === a.address, el => el.child(pin))');
	if (!text.endsWith('\n  }\n}\n') || /^  close\(/m.test(text)) throw new Error("Unsupported agents lifecycle");
	return text.slice(0, -2) + '  close() { this.copySessions?.close(); }\n}\n';
}

async function unchangedWrite(path: string, before: string, after: string): Promise<void> {
	if (await readFile(path, "utf8") !== before) throw new Error(`Personal clone changed during installation: ${path}`);
	await writeFile(path, after);
}

await absent(mod);
await absent(layout);
patchedAgents(await readFile(join(home, "mods/agents/main.js"), "utf8"));
replaceOnce(await readFile(join(home, "layouts/main.json"), "utf8"), '"mod": "agents"', '"mod": "omp-agents"');
const adapter = await readFile(source, "utf8");
const configured = replaceOnce(adapter, '\n\nconst targetFor', `\n\nconst BUN_PATH = ${JSON.stringify(process.execPath)};\nconst QUERY_PATH = ${JSON.stringify(query)};\n\nconst targetFor`);
await appCommand(home, "mod.clone", { name: "agents", as: "omp-agents" });
const clonedMain = await readFile(join(mod, "main.js"), "utf8");
await writeFile(join(mod, "copy-session.js"), configured, { flag: "wx" });
await writeFile(join(mod, "copy.svg"), await readFile(join(import.meta.dir, "copy.svg")), { flag: "wx" });
await unchangedWrite(join(mod, "main.js"), clonedMain, patchedAgents(clonedMain));
const env = { ...process.env, HERDR_APP_HOME: home };
const checked = await execute("herdr-app", ["check", mod], { env, timeout: 15000 });
console.log(checked.stdout.trim());
await appCommand(home, "layout.clone", { name: "main", as: "omp-main" });
const clonedLayout = await readFile(layout, "utf8");
await unchangedWrite(layout, clonedLayout, replaceOnce(clonedLayout, '"mod": "agents"', '"mod": "omp-agents"'));
const status = await execute("herdr-app", ["status"], { env, timeout: 15000 });
console.log(status.stdout.trim());
const evidence = await mkdtemp("/tmp/omp-agents-install-");
const shot = join(evidence, "installed.png");
await execute("herdr-app", ["shot", shot], { env, timeout: 15000 });
console.log(`Installed omp-agents and omp-main. Screenshot: ${shot}`);
