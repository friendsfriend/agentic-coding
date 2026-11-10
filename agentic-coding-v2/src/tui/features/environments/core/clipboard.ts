/**
 * Cross-platform clipboard utilities
 */

import { execSync } from "node:child_process";

/**
 * Copy text to system clipboard
 * Supports macOS, Linux, and Windows
 */
export function copyToClipboard(text: string): boolean {
	try {
		const platform = process.platform;

		if (platform === "darwin") {
			// macOS - use pbcopy
			execSync("pbcopy", { input: text });
		} else if (platform === "linux") {
			// Linux - try xclip first, fall back to xsel
			try {
				execSync("xclip -selection clipboard", { input: text });
			} catch {
				execSync("xsel --clipboard --input", { input: text });
			}
		} else if (platform === "win32") {
			// Windows - use clip
			execSync("clip", { input: text });
		} else {
			console.error(`Clipboard copy not supported on platform: ${platform}`);
			return false;
		}

		return true;
	} catch (error) {
		console.error("Failed to copy to clipboard:", error);
		return false;
	}
}

/**
 * Read text from system clipboard
 * Supports macOS, Linux, and Windows
 */
export function readFromClipboard(): string | null {
	try {
		const platform = process.platform;

		if (platform === "darwin") {
			return execSync("pbpaste", { encoding: "utf8" });
		}

		if (platform === "linux") {
			try {
				return execSync("xclip -selection clipboard -o", { encoding: "utf8" });
			} catch {
				return execSync("xsel --clipboard --output", { encoding: "utf8" });
			}
		}

		if (platform === "win32") {
			return execSync("powershell -NoProfile -Command Get-Clipboard", {
				encoding: "utf8",
			});
		}

		console.error(`Clipboard read not supported on platform: ${platform}`);
		return null;
	} catch (error) {
		console.error("Failed to read from clipboard:", error);
		return null;
	}
}
