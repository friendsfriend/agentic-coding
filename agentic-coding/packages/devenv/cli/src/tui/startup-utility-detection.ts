import { getLogger } from "@devenv/core";

const OPTIONAL_UTILITIES = [
	"lazygit",
	"lazydocker",
	"pi",
	"kubectl",
	"helm",
	"kind",
	"k9s",
	"worktrunk",
	"ssh",
] as const;

/**
 * Check if a binary exists in PATH (non-blocking).
 * Uses `which` on Unix, `where` on Windows.
 */
function commandExists(bin: string): boolean {
	try {
		const { spawnSync } =
			require("node:child_process") as typeof import("child_process");
		const checker = process.platform === "win32" ? "where" : "which";
		return (
			spawnSync(checker, [bin], { stdio: "ignore", shell: false }).status === 0
		);
	} catch {
		return false;
	}
}

/**
 * Detect optional utilities and write diagnostic logging only.
 */
export function detectOptionalUtilities(): void {
	const found: string[] = [];
	for (const util of OPTIONAL_UTILITIES) {
		if (commandExists(util)) {
			found.push(util);
		}
	}

	if (found.length === 0) return;

	getLogger().write("INFO", `Found utilities: ${found.join(", ")}`);
}
