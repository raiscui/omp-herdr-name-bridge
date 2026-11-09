import { isAbsolute } from "node:path";
import { object } from "./herdr";

export interface LocalTarget {
	home: string;
	space: string;
	tab: string;
	pane: string;
	terminal: string;
}

export interface RuntimeIdentity {
	core: string;
	runtime: string;
	pid: number;
	epoch: number;
}

export type CopyResult = { kind: "resolved"; sessionId: string } | { kind: "unavailable"; reason: string };

function id(raw: unknown): string {
	if (typeof raw !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(raw) || raw === "." || raw === "..") throw new Error("Invalid local target identifier");
	return raw;
}

export function localTarget(raw: unknown): LocalTarget {
	const target = object(raw);
	if (typeof target.home !== "string" || !isAbsolute(target.home) || target.home.includes("\0")) throw new Error("Invalid app home");
	const terminal = id(target.terminal);
	if (!/^t[a-zA-Z0-9]+$/.test(terminal)) throw new Error("Remote or invalid terminal");
	return { home: target.home, space: id(target.space), tab: id(target.tab), pane: id(target.pane), terminal };
}

export function runtimeIdentity(raw: unknown): RuntimeIdentity {
	const identity = object(raw);
	const core = id(identity.core);
	if (typeof identity.runtime !== "string" || !/^[a-f0-9-]{36}$/.test(identity.runtime)
		|| !Number.isInteger(identity.pid) || Number(identity.pid) <= 0
		|| !Number.isInteger(identity.epoch) || Number(identity.epoch) <= 0) throw new Error("Invalid runtime identity");
	return { core, runtime: identity.runtime, pid: Number(identity.pid), epoch: Number(identity.epoch) };
}

export function sessionId(raw: unknown): string {
	if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(raw)) throw new Error("Invalid session ID");
	return raw;
}
