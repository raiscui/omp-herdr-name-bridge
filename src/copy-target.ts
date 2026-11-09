import { appCommand, object, rpc, snapshot, terminalTab, type HerdrSnapshot } from "./herdr";
import type { LocalTarget } from "./copy-types";

function documentPane(raw: unknown, target: LocalTarget): boolean {
	const nodes = [raw];
	let visited = 0;
	let matches = 0;
	while (nodes.length) {
		if (++visited > 4096) throw new Error("Layout tree exceeds bridge limit");
		const node = object(nodes.pop());
		if (node.type === "block") {
			if (node.id === target.pane && object(node.content).terminal === target.terminal) matches++;
		} else {
			if (!["row", "column", "stack"].includes(String(node.type)) || !Array.isArray(node.children)) throw new Error("Invalid layout tree");
			nodes.push(...node.children);
		}
	}
	return matches === 1;
}

function coreTarget(world: HerdrSnapshot, docReply: unknown, target: LocalTarget): boolean {
	const tab = terminalTab(world, target.terminal);
	if (tab?.id !== target.tab || tab.space !== target.space || !tab.terminals.has(target.terminal)) return false;
	const doc = object(object(docReply).value);
	if (!Array.isArray(doc.spaces)) throw new Error("Invalid core document");
	const spaces = doc.spaces.filter(raw => object(raw).id === target.space);
	if (spaces.length !== 1 || !Array.isArray(object(spaces[0]).tabs)) return false;
	const tabs = (object(spaces[0]).tabs as unknown[]).filter(raw => object(raw).id === target.tab);
	return tabs.length === 1 && documentPane(object(tabs[0]).root, target);
}

export function matchesAppTarget(raw: unknown, target: LocalTarget): boolean {
	const world = object(raw);
	if (!Array.isArray(world.spaces)) throw new Error("Invalid app snapshot");
	const spaces = world.spaces.filter(rawSpace => {
		const space = object(rawSpace);
		return space.machine === null && space.id === target.space;
	});
	if (spaces.length !== 1 || !Array.isArray(object(spaces[0]).tabs)) return false;
	const tabs = (object(spaces[0]).tabs as unknown[]).filter(rawTab => object(rawTab).id === target.tab);
	if (tabs.length !== 1 || !Array.isArray(object(tabs[0]).terminals)) return false;
	return (object(tabs[0]).terminals as unknown[]).filter(rawTerminal => {
		const terminal = object(rawTerminal);
		return terminal.terminal === target.terminal && terminal.pane === target.pane;
	}).length === 1;
}

export async function matchesCopyTarget(binding: { endpoint: string; core: string; pid: number; target: LocalTarget; mode: "availability" | "resolve" }): Promise<boolean> {
	const { endpoint, core, pid, target, mode } = binding;
	const [world, replies, app] = await Promise.all([
		snapshot(endpoint),
		rpc(endpoint, [{ method: "doc.get", params: { name: "herdr-app" } }, { method: "terminal.get", params: { terminal: target.terminal } }]),
		mode === "resolve" ? appCommand(target.home, "ls") : Promise.resolve(null),
	]);
	const terminal = object(replies[1]);
	const foreground = object(terminal.foreground);
	return world.core === core && terminal.address === target.terminal && terminal.state === "live" && foreground.pid === pid
		&& terminal.reported === true && object(terminal.status).app === "omp"
		&& coreTarget(world, replies[0], target) && (mode === "availability" || matchesAppTarget(app, target));
}
