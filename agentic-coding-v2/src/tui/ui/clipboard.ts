import { spawnSync } from "node:child_process";

export type ClipboardResult =
	| "accepted"
	| "sent-unverified"
	| "unavailable"
	| "too-large";
/** Explicit user-copy only. Original helper order; no shell, file read, model,
 * provider request or automatic selection export. Exit zero is helper acceptance,
 * not proof of the clipboard contents; OSC 52 has no acknowledgement. */
export function copyToClipboard(text: string): ClipboardResult {
	if (Buffer.byteLength(text, "utf8") > 256000) return "too-large";
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
	for (const entry of commands) {
		const command = entry[0];
		if (!command) continue;
		const executable = Bun.which(command);
		if (!executable) continue;
		try {
			const result = spawnSync(executable, entry.slice(1), {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: 1000,
			});
			if (!result.error && result.status === 0) return "accepted";
		} catch {
			/* Try the next helper without printing into the renderer. */
		}
	}
	if (
		process.platform === "darwin" ||
		process.platform === "win32" ||
		!process.stdout.isTTY ||
		process.stdout.destroyed ||
		!process.stdout.writable
	)
		return "unavailable";
	const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
	try {
		process.stdout.write(
			process.env.TMUX ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence,
		);
		return "sent-unverified";
	} catch {
		return "unavailable";
	}
}
