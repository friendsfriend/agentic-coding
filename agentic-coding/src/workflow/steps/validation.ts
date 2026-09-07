import fs from "node:fs";
import path from "node:path";
import type { WorkflowSnapshot } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";

const MAX_EVIDENCE_FILES = 2000;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;
function readEvidenceFile(file: string): string {
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES)
		throw new WorkflowRuntimeError("entry-guard", "evidence file is unbounded");
	return fs.readFileSync(file, "utf8");
}
export interface PreparedStepEvidence {
	planning?: { complete: boolean; hasScenario: boolean };
	implementation?: { tasksComplete: boolean };
	archive?: { activeExists: boolean; archived: boolean };
}

export function prepareStepEvidence(
	snapshot: WorkflowSnapshot,
): PreparedStepEvidence {
	const root = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		snapshot.metadata.changeId,
	);
	const files = ["proposal.md", "design.md", "tasks.md"].map((name) =>
		path.join(root, name),
	);
	const contents = files.map((file) =>
		fs.existsSync(file) ? readEvidenceFile(file) : "",
	);
	const specs = path.join(root, "specs");
	const hasScenario = fs.existsSync(specs)
		? walkFiles(specs).some((file) =>
				/#### Scenario:/.test(readEvidenceFile(file)),
			)
		: false;
	const archive = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		"archive",
	);
	const archiveNames = fs.existsSync(archive)
		? fs.readdirSync(archive).slice(0, MAX_EVIDENCE_FILES)
		: [];
	return {
		planning: {
			complete: contents.every((content) => Boolean(content.trim())),
			hasScenario,
		},
		implementation: {
			tasksComplete:
				Boolean(contents[2]) && !/^\s*[-*]\s+\[ \]/m.test(contents[2]),
		},
		archive: {
			activeExists: fs.existsSync(root),
			archived: archiveNames.some(
				(name) =>
					name === snapshot.metadata.changeId ||
					name.endsWith(`-${snapshot.metadata.changeId}`),
			),
		},
	};
}

function walkFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(file));
		else {
			files.push(file);
			if (files.length > MAX_EVIDENCE_FILES)
				throw new WorkflowRuntimeError(
					"entry-guard",
					"too many evidence files",
				);
		}
	}
	return files;
}

/** Planning and consolidation both must leave a complete OpenSpec change
 * directory behind before their completion counts. */
export function validatePlanningArtifacts(
	_evidence: PreparedStepEvidence,
): void {
	const evidence = _evidence;
	if (!evidence.planning?.complete)
		throw new WorkflowRuntimeError("entry-guard", "planning artifact invalid");
	if (!evidence.planning.hasScenario)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"planning requires at least one OpenSpec scenario",
		);
}

export function validateImplementationEvidence(
	evidence: PreparedStepEvidence,
): void {
	if (!evidence.implementation?.tasksComplete)
		throw new WorkflowRuntimeError(
			"entry-guard",
			"implementation requires completed OpenSpec tasks",
		);
}

export function validateArchiveEvidence(evidence: PreparedStepEvidence): void {
	if (evidence.archive?.activeExists || !evidence.archive?.archived)
		throw new WorkflowRuntimeError("entry-guard", "archive move not found");
}
