import fs from "node:fs";
import path from "node:path";
import type { WorkflowSnapshot } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";

function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(file));
		else files.push(file);
	}
	return files;
}

/** Planning and consolidation both must leave a complete OpenSpec change
 * directory behind before their completion counts. */
export function validatePlanningArtifacts(snapshot: WorkflowSnapshot): void {
	const root = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		snapshot.metadata.changeId,
	);
	for (const file of ["proposal.md", "design.md", "tasks.md"])
		if (
			!fs.existsSync(path.join(root, file)) ||
			!fs.readFileSync(path.join(root, file), "utf8").trim()
		)
			throw new WorkflowRuntimeError(
				"entry-guard",
				`planning artifact invalid: ${file}`,
			);
	const specs = path.join(root, "specs");
	if (
		!fs.existsSync(specs) ||
		!walkFiles(specs).some((file) =>
			/#### Scenario:/.test(fs.readFileSync(file, "utf8")),
		)
	)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"planning requires at least one OpenSpec scenario",
		);
}

export function validateImplementationEvidence(
	snapshot: WorkflowSnapshot,
): void {
	if (snapshot.definition.id === "no-openspec") return;
	const tasks = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		snapshot.metadata.changeId,
		"tasks.md",
	);
	if (
		!fs.existsSync(tasks) ||
		/^\s*[-*]\s+\[ \]/m.test(fs.readFileSync(tasks, "utf8"))
	)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"implementation requires completed OpenSpec tasks",
		);
}

export function validateArchiveEvidence(snapshot: WorkflowSnapshot): void {
	const active = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		snapshot.metadata.changeId,
	);
	const archive = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		"archive",
	);
	if (
		fs.existsSync(active) ||
		!fs.existsSync(archive) ||
		!fs
			.readdirSync(archive)
			.some(
				(name) =>
					name === snapshot.metadata.changeId ||
					name.endsWith(`-${snapshot.metadata.changeId}`),
			)
	)
		throw new WorkflowRuntimeError("entry-guard", "archive move not found");
}
