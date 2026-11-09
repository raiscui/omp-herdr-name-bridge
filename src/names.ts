export interface NameSnapshot {
	binding: string;
	omp: string;
	tab: string;
}

export interface NameBaseline extends NameSnapshot {
	pendingTab?: { before: string; target: string; until: number };
	manualTab?: true;
}

export type NameDecision =
	| { kind: "settled"; baseline: NameBaseline }
	| { kind: "waiting" }
	| { kind: "renameTab"; name: string }
	| { kind: "renameOmp"; name: string; baseline: NameBaseline };

export function nameDecision(previous: NameBaseline | undefined, current: NameSnapshot, now: number): NameDecision {
	if (previous?.binding !== current.binding) {
		if (current.omp && current.omp !== current.tab) return { kind: "renameTab", name: current.omp };
		if (!current.omp) return { kind: "waiting" };
		return { kind: "settled", baseline: current };
	}
	const pending = previous.pendingTab;
	if (pending && current.tab === pending.before && now < pending.until) return { kind: "waiting" };
	const tabChanged = current.tab !== previous.tab && current.tab !== pending?.target;
	const manualTab = previous.manualTab || tabChanged;
	const baseline: NameBaseline = manualTab ? { ...current, manualTab: true } : current;
	if (tabChanged && current.tab) return { kind: "renameOmp", name: current.tab, baseline };
	if (manualTab || current.omp === current.tab) return { kind: "settled", baseline };
	if (current.omp !== previous.omp || (pending && current.tab === pending.before)) {
		return current.omp ? { kind: "renameTab", name: current.omp } : { kind: "waiting" };
	}
	return { kind: "settled", baseline };
}

export function validName(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) {
		throw new Error("Invalid name from naming boundary");
	}
	return raw.trim();
}
