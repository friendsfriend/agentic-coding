import { spawnSync } from "node:child_process";

/** Write text to the terminal via an OSC 52 clipboard-set escape sequence, so
 * the copy can still work in terminals that honor OSC 52 (including over SSH
 * or inside tmux) even when no clipboard binary is installed at all. This is
 * fire-and-forget: terminals don't acknowledge OSC 52, so there's no way to
 * confirm it actually landed. */
export function writeOsc52(text: string) {
	const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
	process.stdout.write(
		process.env.TMUX ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence,
	);
}

/** Copy text to the system clipboard, trying platform-appropriate commands in
 * order and falling back to an OSC 52 escape sequence if every command fails
 * (e.g. no clipboard binary installed). Returns whether the copy is believed
 * to have succeeded; the OSC 52 fallback always reports success since it
 * can't be confirmed. */
export function copyToClipboard(text: string): boolean {
	const commands =
		process.platform === "darwin"
			? [["pbcopy"]]
			: process.platform === "win32"
				? [["clip"]]
				: [
						["wl-copy"],
						["xclip", "-selection", "clipboard"],
						["xsel", "--clipboard", "--input"],
					];
	for (const [command, ...args] of commands) {
		// Do not invoke unavailable helpers (or a shell's command-not-found
		// handler). A fallback failure must never print into the live renderer.
		const executable = Bun.which(command);
		if (!executable) continue;
		try {
			const result = spawnSync(executable, args, {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: 1000,
			});
			if (!result.error && result.status === 0) return true;
		} catch {
			// Try the next helper, silently, even if spawning itself fails.
		}
	}
	if (process.platform !== "darwin" && process.platform !== "win32") {
		writeOsc52(text);
		return true;
	}
	return false;
}
