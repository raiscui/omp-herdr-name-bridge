import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { NameBridge } from "./bridge";

export default function herdrNameBridge(pi: ExtensionAPI): void {
	if (!process.env.HC_TERMINAL_ID || process.platform === "win32") return;
	let bridge: NameBridge | undefined;
	let context: ExtensionContext | undefined;
	let timer: Timer | undefined;
	let closing = false;
	let lastStatus = "";

	function status(message: string): void {
		if (context?.mode === "tui" && message !== lastStatus) {
			context.ui.setStatus("herdr-name-bridge", message.startsWith("paused") ? `Herdr names ${message}` : undefined);
		}
		lastStatus = message;
	}

	async function tick(): Promise<void> {
		if (closing || !bridge || !context) return;
		try { status(await bridge.synchronize()); }
		catch (error) { status(`paused: ${error instanceof Error ? error.message : String(error)}`); }
		if (!closing) timer = context.setTimeout(tick, 1000);
	}

	function activate(_event: unknown, ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		context = ctx;
		try {
			bridge ||= new NameBridge({
				sessionId: () => context!.sessionManager.getSessionId(),
				getName: () => pi.getSessionName(),
				setName: name => pi.setSessionName(name),
			});
			bridge.activate();
			if (!timer) timer = ctx.setTimeout(tick, 0);
		} catch (error) { status(`paused: ${error instanceof Error ? error.message : String(error)}`); }
	}

	pi.on("session_start", activate);
	pi.on("session_switch", activate);
	pi.on("session_branch", activate);
	pi.on("session_tree", activate);
	pi.on("session_shutdown", async () => {
		closing = true;
		if (timer) context?.clearTimer(timer);
		try { await bridge?.close(); }
		catch (error) { status(`paused: cleanup failed: ${String(error)}`); }
	});
}
