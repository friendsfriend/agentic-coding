// Evidence preparation for entry-guard validation: reads the bounded
// OpenSpec change-directory files the step hooks validate. This is the
// filesystem/observation half of evidence handling and belongs in the
// runtime layer (enforce-source-layer-boundaries) — step behavior must stay
// pure and receive already-prepared `PreparedStepEvidence` (the runtime
// calls `prepareStepEvidence` and passes it into `validateEvidence`).
import fs from "node:fs";
import path from "node:path";
import type { WorkflowSnapshot } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	openSecureDirectory,
	openSecureFile,
	secureDirectoryNames,
} from "../secure-fs.ts";
import type { PreparedStepEvidence } from "../steps/validation.ts";

const MAX_EVIDENCE_FILES = 2000;
const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

function readEvidenceFile(file: string, root: string): string {
	const lexicalRoot = path.resolve(root);
	let directory: number | undefined;
	let fd: number | undefined;
	try {
		fs.realpathSync(lexicalRoot);
		directory = openSecureDirectory(path.dirname(file), lexicalRoot, false);
		fd = openSecureFile(directory, path.basename(file));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES)
			throw new WorkflowRuntimeError(
				"entry-guard",
				"evidence file is unbounded",
			);
		const buffer = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_EVIDENCE_FILE_BYTES)
			throw new WorkflowRuntimeError(
				"entry-guard",
				"evidence file is unbounded",
			);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch (error) {
		if (error instanceof WorkflowRuntimeError) throw error;
		throw new WorkflowRuntimeError(
			"entry-guard",
			"evidence file must be a bounded regular non-symlink file",
		);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (directory !== undefined) fs.closeSync(directory);
	}
}

/** Reads the bounded evidence directory for the snapshot's change id. */
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
		fs.existsSync(file)
			? readEvidenceFile(file, snapshot.metadata.worktree)
			: "",
	);
	const specs = path.join(root, "specs");
	const hasScenario = fs.existsSync(specs)
		? walkFiles(specs).some((file) =>
				/#### Scenario:/.test(
					readEvidenceFile(file, snapshot.metadata.worktree),
				),
			)
		: false;
	const archive = path.join(
		snapshot.metadata.worktree,
		"openspec",
		"changes",
		"archive",
	);
	const archiveNames = archiveEntriesIfPresent(
		archive,
		snapshot.metadata.worktree,
	);
	return {
		planning: {
			complete: contents.every((content) => Boolean(content.trim())),
			hasScenario,
			...(contents.findIndex((content) => !content.trim()) >= 0
				? {
						missing: files[contents.findIndex((content) => !content.trim())]
							?.split(path.sep)
							.pop(),
					}
				: {}),
		},
		implementation: {
			tasksComplete:
				Boolean(contents[2]) && !/^\s*[-*]\s+\[ \]/m.test(contents[2]),
		},
		archive: {
			activeExists: activeChangeExists(root, snapshot.metadata.worktree),
			archived: archiveNames.some(
				(name) =>
					name === snapshot.metadata.changeId ||
					name.endsWith(`-${snapshot.metadata.changeId}`),
			),
		},
	};
}

function activeChangeExists(change: string, root: string): boolean {
	try {
		const stat = fs.lstatSync(change);
		if (stat.isSymbolicLink())
			throw new WorkflowRuntimeError(
				"entry-guard",
				"active change directory must not be a symlink",
			);
		if (!stat.isDirectory()) return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		if (error instanceof WorkflowRuntimeError) throw error;
		throw new WorkflowRuntimeError(
			"entry-guard",
			"active change directory cannot be inspected",
		);
	}
	let directory: number | undefined;
	try {
		directory = openSecureDirectory(change, root, false);
		return true;
	} catch {
		throw new WorkflowRuntimeError(
			"entry-guard",
			"active change directory changed while reading",
		);
	} finally {
		if (directory !== undefined) fs.closeSync(directory);
	}
}

function archiveEntriesIfPresent(archive: string, root: string): string[] {
	try {
		if (fs.lstatSync(archive).isSymbolicLink())
			throw new WorkflowRuntimeError(
				"entry-guard",
				"archive directory must not be a symlink",
			);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		if (error instanceof WorkflowRuntimeError) throw error;
		throw new WorkflowRuntimeError(
			"entry-guard",
			"archive directory cannot be inspected",
		);
	}
	return archiveEntries(archive, root);
}

function archiveEntries(archive: string, root: string): string[] {
	let directory: number | undefined;
	try {
		directory = openSecureDirectory(archive, root, false);
		return secureDirectoryNames(directory, MAX_EVIDENCE_FILES);
	} catch (error) {
		if (error instanceof WorkflowRuntimeError) throw error;
		throw new WorkflowRuntimeError(
			"entry-guard",
			"archive directory must be a bounded non-symlink directory",
		);
	} finally {
		if (directory !== undefined) fs.closeSync(directory);
	}
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
