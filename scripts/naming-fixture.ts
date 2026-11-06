import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function namingFixture(pi: ExtensionAPI): void {
	async function automatic(name: string, ctx: ExtensionContext): Promise<void> {
		const manager = ctx.sessionManager as typeof ctx.sessionManager & {
			setSessionName(name: string, source: "auto"): Promise<boolean>;
		};
		if (!await manager.setSessionName(name, "auto")) throw new Error("Automatic title update refused");
	}
	pi.on("session_start", async (_event, ctx) => {
		await automatic(process.env.BRIDGE_TEST_INITIAL || "Existing OMP", ctx);
	});
	pi.registerCommand("bridge-test-auto", {
		description: "Exercise OMP's real automatic-title setter in an isolated verification process",
		handler: automatic,
	});
	pi.registerCommand("bridge-test-stable", {
		description: "Assert the OMP title revision stays unchanged while names are equal",
		handler: async (_args, ctx) => {
			const manager = ctx.sessionManager as typeof ctx.sessionManager & { titleRevision: number };
			const revision = manager.titleRevision;
			await Bun.sleep(2300);
			await Bun.write(`${process.env.HOME}/title-revision.json`, JSON.stringify({ before: revision, after: manager.titleRevision }));
			if (manager.titleRevision !== revision) throw new Error("Equal names changed the OMP title revision");
		},
	});
}
