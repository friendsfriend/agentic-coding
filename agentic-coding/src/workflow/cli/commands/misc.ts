// The remaining small operator/administrative commands: `repair`, `repin`,
// `agent-extension`, and the `listProjects` helper backing `projects`.
// Moved verbatim out of cli.ts (split-workflow-god-modules).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manageAgentExtension } from "../../agent-extensions.ts";
import { loadConfig } from "../../effects.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { flag, positional, requireFlag } from "../args.ts";
import { drainEffects } from "../drain.ts";
import { AGENT_EXTENSION_SUBCOMMANDS } from "../schema.ts";

export function listProjects(): Array<{
	name: string;
	path: string;
	openspec: boolean;
}> {
	const config = loadConfig().projects;
	const root = path.resolve(String(config.root).replace(/^~/, os.homedir()));
	const found: Array<{ name: string; path: string; openspec: boolean }> = [];
	const walk = (directory: string, depth: number) => {
		if (depth > config.max_depth) return;
		try {
			if (!fs.existsSync(directory)) return;
			if (fs.existsSync(path.join(directory, ".git"))) {
				found.push({
					name: path.relative(root, directory) || ".",
					path: directory,
					openspec: fs.existsSync(
						path.join(directory, "openspec", "config.yaml"),
					),
				});
				return;
			}
			for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
				if (
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					!["node_modules", "dist", "build", "target"].includes(entry.name)
				)
					walk(path.join(directory, entry.name), depth + 1);
		} catch {
			return;
		}
	};
	walk(root, 0);
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runRepair(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
): Promise<void> {
	if (!rest.includes("--confirm")) {
		console.log(
			JSON.stringify(
				workflowEngine.previewRepair(repo, requireFlag(rest, "change")),
				null,
				2,
			),
		);
		return;
	}
	const view = workflowEngine.status(repo, requireFlag(rest, "change"));
	workflowEngine.dispatch(repo, {
		type: "operator.repair",
		workflowId: view.workflowId,
		revision: Number(flag(rest, "revision")),
		targetStep: flag(rest, "step"),
		reason: flag(rest, "reason") ?? "",
	});
	await drainEffects(workflowEngine, repo);
	console.log(
		JSON.stringify(
			workflowEngine.status(repo, requireFlag(rest, "change")),
			null,
			2,
		),
	);
}

export async function runRepin(
	rest: string[],
	workflowEngine: WorkflowEngine,
	repo: string,
): Promise<void> {
	const view = workflowEngine.status(repo, requireFlag(rest, "change"));
	const revision =
		flag(rest, "revision") === undefined
			? view.revision
			: Number(flag(rest, "revision"));
	workflowEngine.dispatch(repo, {
		type: "operator.repin",
		workflowId: view.workflowId,
		revision,
	});
	await drainEffects(workflowEngine, repo);
	console.log(
		JSON.stringify(
			workflowEngine.status(repo, requireFlag(rest, "change")),
			null,
			2,
		),
	);
}

export function runAgentExtension(rest: string[]): void {
	const [subcommand, ...args] = rest;
	if (!(AGENT_EXTENSION_SUBCOMMANDS as readonly string[]).includes(subcommand))
		throw new Error(
			`unknown agent-extension command: ${subcommand ?? "(none)"}`,
		);
	const profiles: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--profile") continue;
		const next = args[index + 1];
		if (next !== undefined) profiles.push(next);
	}
	if (subcommand === "list") manageAgentExtension({ command: "list" });
	else if (subcommand === "install")
		manageAgentExtension({
			command: "install",
			source: positional(args),
			profiles,
		});
	else
		manageAgentExtension({
			command: "install-local",
			source: positional(args),
			profiles,
		});
}
