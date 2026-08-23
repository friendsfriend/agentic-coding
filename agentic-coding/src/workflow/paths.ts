// Static path constants. Module-level so tests/tools can override via env.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

/** True when running inside a compiled bun binary (sources are bundled under a
 * virtual /$bunfs/root/, so file-relative walks break). */
export function isCompiled(): boolean {
	return (
		import.meta.url.includes("/$bunfs/") || import.meta.url.includes("B:/~BUN/")
	);
}

/** Directory where a compiled binary materializes the bundled agent-definitions. */
export const MATERIALIZED_AGENT_DEF_DIR = path.join(
	os.homedir(),
	".local",
	"share",
	"agentic-coding",
	"agent-definitions",
);

// Resolution order: explicit override -> compiled asset fallback -> source tree.
const here = fileURLToPath(import.meta.url);
export const AGENT_DEF_DIR =
	process.env.HERDR_AGENT_DEF_DIR ||
	(isCompiled()
		? MATERIALIZED_AGENT_DEF_DIR
		: path.resolve(path.dirname(here), "..", "..", "..", "agent-definitions"));

export const CONFIG =
	process.env.HERDR_WORKFLOW_CONFIG ||
	path.join(os.homedir(), ".config", "agentic-coding", "config.toml");
