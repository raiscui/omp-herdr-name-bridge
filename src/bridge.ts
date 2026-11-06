import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { coreEndpoint, snapshot, terminalTab, appCommand, requireAppTab } from "./herdr";
import { nameDecision, validName, type NameBaseline, type NameSnapshot } from "./names";
import { Registry, type Registration } from "./registry";

export interface NamingHost {
	sessionId(): string;
	getName(): string | undefined;
	setName(name: string): Promise<void>;
}

export class NameBridge {
	readonly runtime = randomUUID();
	readonly home: string;
	readonly terminal: string;
	private epoch = 0;
	private session = "";
	private registry?: Registry;
	private core = "";
	private baselines = new Map<string, NameBaseline>();
	private stopped = false;
	private inFlight?: Promise<string>;

	constructor(private host: NamingHost) {
		this.terminal = process.env.HC_TERMINAL_ID || "";
		this.home = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
		if (!/^t[a-zA-Z0-9]+$/.test(this.terminal) || !isAbsolute(this.home)) throw new Error("Bridge requires a local HC_TERMINAL_ID and absolute HERDR_APP_HOME");
	}

	activate(): void {
		const session = this.host.sessionId();
		if (session !== this.session) {
			this.session = session;
			this.epoch++;
			this.baselines.clear();
		}
	}

	synchronize(): Promise<string> {
		if (!this.inFlight) this.inFlight = this.reconcile().finally(() => { this.inFlight = undefined; });
		return this.inFlight;
	}

	private registration(): Registration {
		return { version: 1, runtime: this.runtime, pid: process.pid, terminal: this.terminal,
			session: this.session, epoch: this.epoch, heartbeat: Date.now() };
	}

	private current(epoch: number): boolean {
		return !this.stopped && epoch === this.epoch && this.session === this.host.sessionId();
	}

	private async reconcile(): Promise<string> {
		if (this.stopped || !this.session) return "inactive";
		const epoch = this.epoch;
		const endpoint = await coreEndpoint();
		const world = await snapshot(endpoint);
		if (!this.current(epoch)) return "session changed";
		if (world.core !== this.core) {
			await this.registry?.remove();
			this.core = world.core;
			this.registry = new Registry(world.core, this.runtime);
		}
		const registration = this.registration();
		await this.registry!.publish(registration);
		const tab = terminalTab(world, this.terminal);
		if (!tab || !await this.registry!.unique(world, registration)) return "paused: membership unavailable or multiple OMP instances";
		await requireAppTab(this.home, tab);
		if (!this.current(epoch)) return "session changed";
		const binding = `${world.core}/${tab.id}/${this.epoch}`;
		const observed: NameSnapshot = { binding, omp: validName(this.host.getName() || ""), tab: tab.name };
		const previous = this.baselines.get(binding);
		const decision = nameDecision(previous, observed, Date.now());
		if (decision.kind === "settled") this.baselines.set(binding, decision.baseline);
		if (decision.kind === "settled" || decision.kind === "waiting") return decision.kind;
		const fresh = await snapshot(endpoint);
		const freshTab = terminalTab(fresh, this.terminal);
		const unique = await this.registry!.unique(fresh, registration);
		if (!this.current(epoch) || fresh.core !== world.core || freshTab?.id !== tab.id || freshTab.name !== observed.tab
			|| validName(this.host.getName() || "") !== observed.omp || !unique) return "changed before rename";
		if (decision.kind === "renameTab") {
			await appCommand(this.home, "tab.rename", { id: tab.id, name: decision.name });
			this.baselines.set(binding, { ...observed, pendingTab: { before: observed.tab, target: decision.name, until: Date.now() + 5000 } });
			return "waiting for tab acknowledgement";
		}
		await this.host.setName(decision.name);
		if (this.current(epoch)) {
			const applied = validName(this.host.getName() || "");
			if (applied === observed.omp && applied !== decision.name) throw new Error("OMP refused the tab rename");
			this.baselines.set(binding, { ...observed, omp: applied });
		}
		return "session renamed";
	}

	async close(): Promise<void> {
		this.stopped = true;
		this.epoch++;
		try { await this.inFlight; } finally { await this.registry?.remove(); }
	}
}
