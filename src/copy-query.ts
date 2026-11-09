import { copyCandidates } from "./registry";
import { queryRuntime } from "./copy-socket";
import { localTarget, type CopyResult, type LocalTarget } from "./copy-types";
import { appCommand } from "./herdr";
import { matchesAppTarget } from "./copy-target";

const unavailable = (reason: string): CopyResult => ({ kind: "unavailable", reason });

export async function querySessions(rawTargets: unknown[], mode: "availability" | "resolve" = "resolve"): Promise<CopyResult[]> {
	if (rawTargets.length > 16) throw new Error("Too many copy targets");
	const targets: (LocalTarget | undefined)[] = rawTargets.map(raw => {
		try { return localTarget(raw); } catch { return undefined; }
	});
	const candidates = await copyCandidates(new Set(targets.flatMap(target => target ? [target.terminal] : [])));
	const requests = targets.reduce((count, target) => count + candidates.filter(peer => peer.registration.terminal === target?.terminal).length, 0);
	if (requests > 64) return targets.map(() => unavailable("too-many-candidates"));
	const appSnapshots = new Map<string, unknown>();
	if (mode === "availability") {
		const homes = new Set(targets.flatMap(target => target ? [target.home] : []));
		await Promise.all([...homes].map(async home => {
			try { appSnapshots.set(home, await appCommand(home, "ls")); }
			catch { appSnapshots.set(home, null); }
		}));
	}
	return Promise.all(targets.map(async target => {
		if (!target) return unavailable("invalid-target");
		if (mode === "availability") {
			try { if (!matchesAppTarget(appSnapshots.get(target.home), target)) return unavailable("not-target"); }
			catch { return unavailable("unverified"); }
		}
		const peers = candidates.filter(peer => peer.registration.terminal === target.terminal);
		if (!peers.length) return unavailable("not-found");
		const replies = await Promise.all(peers.map(async peer => {
			try {
				return (await queryRuntime(target, { core: peer.core, runtime: peer.registration.runtime, pid: peer.registration.pid }, mode)).result;
			} catch { return unavailable("unverified"); }
		}));
		const resolved = replies.filter((reply): reply is Extract<CopyResult, { kind: "resolved" }> => reply.kind === "resolved");
		if (resolved.length > 1) return unavailable("ambiguous");
		if (replies.some(reply => reply.kind === "unavailable" && reply.reason !== "not-target")) return unavailable("unverified");
		return resolved[0] || unavailable("not-found");
	}));
}
