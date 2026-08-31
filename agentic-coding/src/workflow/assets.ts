import fs from "node:fs";
import path from "node:path";
import {
	AGENT_DEFINITION_VERSION,
	AGENT_DEFINITIONS,
} from "./embedded.generated.ts";
import { AGENT_DEF_DIR, isCompiled } from "./paths.ts";

export function workflowAssets(
	worktree: string,
	changeId: string,
	storageRoot?: string,
): string {
	if (!isCompiled()) return AGENT_DEF_DIR;
	const workflowRoot = path.resolve(
		storageRoot ?? path.join(worktree, ".herdr-workflow"),
	);
	const root = path.resolve(workflowRoot, changeId, "agent-assets");
	if (!root.startsWith(`${workflowRoot}${path.sep}`))
		throw new Error("workflow asset path escapes worktree");
	const marker = path.join(root, ".version");
	if (
		fs.existsSync(marker) &&
		fs.readFileSync(marker, "utf8") === AGENT_DEFINITION_VERSION
	)
		return root;
	fs.mkdirSync(root, { recursive: true });
	for (const [relative, content] of Object.entries(AGENT_DEFINITIONS)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	fs.writeFileSync(marker, AGENT_DEFINITION_VERSION);
	return root;
}
