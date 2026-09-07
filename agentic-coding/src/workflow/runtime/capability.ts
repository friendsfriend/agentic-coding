// The security boundary (design D2): token hashing/comparison, run
// capability issuance, agent and exact-run authorization, and the artifact
// path/size/schema/digest checks bounded by MAX_ARTIFACT_BYTES. Extracted as
// one cohesive unit rather than spread across files, so it can be reviewed
// and tested as a whole. Moved verbatim out of runtime.ts
// (split-workflow-god-modules).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowRun } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import type { WorkflowRegistry } from "../registry.ts";
import {
	openCanonicalDirectory,
	openSecureDirectory,
	openSecureDirectoryRelative,
	openSecureFile,
} from "../secure-fs.ts";
import {
	ACTIVE_RUN,
	getSnapshot,
	openStore,
	type RunRow,
	activeRunForRole as storeActiveRunForRole,
	getRun as storeGetRun,
} from "./store.ts";

export const MAX_ARTIFACT_BYTES = 512 * 1024;

function canonicalTrustedRoot(root: string): string {
	const lexical = path.resolve(root);
	const temporary = path.resolve(os.tmpdir());
	const canonicalTemporary = fs.realpathSync(temporary);
	const canonical =
		lexical === temporary || lexical.startsWith(`${temporary}${path.sep}`)
			? path.join(canonicalTemporary, path.relative(temporary, lexical))
			: lexical;
	if (fs.realpathSync(canonical) !== canonical)
		throw new WorkflowRuntimeError(
			"artifact",
			"trusted artifact root contains a symlinked component",
		);
	return canonical;
}

function openTrustedRoot(root: string): number {
	const canonical = canonicalTrustedRoot(root);
	const expected = fs.statSync(canonical);
	const descriptor = openCanonicalDirectory(canonical, canonical);
	const opened = fs.fstatSync(descriptor);
	if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
		fs.closeSync(descriptor);
		throw new WorkflowRuntimeError(
			"artifact",
			"trusted artifact root changed while opening",
		);
	}
	return descriptor;
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
export function tokenMatches(token: string, hash: string): boolean {
	const actual = Buffer.from(hashToken(token), "hex");
	const expected = Buffer.from(hash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueRunCapability(repo: string, runId: string): string {
	const db = openStore(repo);
	try {
		db.exec("BEGIN IMMEDIATE");
		const row = db
			.query("SELECT * FROM workflow_runs WHERE id=?")
			.get(runId) as RunRow | null;
		if (!row || !ACTIVE_RUN.has(row.status))
			throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
		const token = randomBytes(32).toString("base64url");
		db.query("UPDATE workflow_runs SET capability_hash=? WHERE id=?").run(
			hashToken(token),
			runId,
		);
		db.exec("COMMIT");
		return token;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* no transaction */
		}
		throw error;
	} finally {
		db.close();
	}
}

/** Validate the launch-bound capability for a role-scoped CLI operation. */
export function authorizeAgentCapability(
	repo: string,
	workflowId: string,
	stepId: string,
	role: string,
	token: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowRun {
	if (!token)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"authenticated run capability is required",
		);
	const run = storeActiveRunForRole(repo, workflowId, stepId, role);
	const snapshot = getSnapshot(repo, workflowId, registry, now);
	if (
		snapshot.currentStep !== stepId ||
		!snapshot.step.activeRunIds.includes(run.id) ||
		!run.capabilityHash ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
		!tokenMatches(token, run.capabilityHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or inactive run capability",
		);
	return run;
}

/** Validate a capability against the exact run that issued it. This is used
 * by subprocess-facing commands; role-scoped lookup is intentionally not
 * sufficient because a child process must not select a sibling run. */
export function authorizeExactRunCapability(
	repo: string,
	workflowId: string,
	runId: string,
	stepId: string,
	role: string,
	token: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowRun {
	if (!token)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"authenticated run capability is required",
		);
	const run = storeGetRun(repo, runId);
	const snapshot = getSnapshot(repo, workflowId, registry, now);
	if (
		run.workflowId !== workflowId ||
		run.stepId !== stepId ||
		run.role !== role ||
		snapshot.currentStep !== stepId ||
		!snapshot.step.activeRunIds.includes(run.id) ||
		!ACTIVE_RUN.has(run.status) ||
		!run.capabilityHash ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
		!tokenMatches(token, run.capabilityHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or inactive run capability",
		);
	return run;
}

export function prepareHandoffArtifact(
	repo: string,
	command: {
		runId: string;
		generation: number;
		token: string;
		artifact?: string;
	},
	now: () => Date,
	trustedRoot?: string,
): { output: unknown; digest: string } | undefined {
	if (!command.artifact) return undefined;
	const run = storeGetRun(repo, command.runId);
	if (run.generation !== command.generation || !ACTIVE_RUN.has(run.status))
		throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
	if (
		!run.capabilityHash ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
		!tokenMatches(command.token, run.capabilityHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or expired run capability",
		);
	return artifact(run, command.artifact, trustedRoot);
}

export function artifact(
	run: WorkflowRun,
	submitted?: string,
	trustedRoot?: string,
): { output: unknown; digest: string } {
	if (!submitted || !run.outputPath)
		throw new WorkflowRuntimeError("artifact", "required artifact missing");
	const expected = path.resolve(run.outputPath);
	const actual = path.resolve(submitted);
	if (actual !== expected)
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact path does not match assignment",
		);
	const root = path.resolve(path.dirname(run.assignmentPath));
	if (!actual.startsWith(`${root}${path.sep}`))
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact escapes run directory",
		);
	let trusted: number | undefined;
	let directory: number | undefined;
	let fd: number | undefined;
	try {
		if (trustedRoot !== undefined) {
			const lexicalBase = path.resolve(trustedRoot);
			const target = path.resolve(root);
			const relative = path.relative(lexicalBase, target);
			const base = canonicalTrustedRoot(lexicalBase);
			const expectedDirectory = fs.lstatSync(root);
			if (
				expectedDirectory.isSymbolicLink() ||
				!expectedDirectory.isDirectory()
			)
				throw new WorkflowRuntimeError(
					"artifact",
					"artifact run directory must be a regular directory",
				);
			if (relative.startsWith("..") || path.isAbsolute(relative))
				throw new WorkflowRuntimeError(
					"artifact",
					"artifact run directory escapes the trusted worktree",
				);
			trusted = openTrustedRoot(base);
			directory = openSecureDirectoryRelative(trusted, relative, false);
			const openedDirectory = fs.fstatSync(directory);
			if (
				openedDirectory.dev !== expectedDirectory.dev ||
				openedDirectory.ino !== expectedDirectory.ino
			)
				throw new WorkflowRuntimeError(
					"artifact",
					"artifact run directory changed while opening",
				);
		} else {
			if (fs.lstatSync(root).isSymbolicLink())
				throw new WorkflowRuntimeError(
					"artifact",
					"artifact run directory must not be a symlink",
				);
			const canonicalExpected = fs.realpathSync(root);
			const canonicalDirectory = fs.realpathSync(path.dirname(actual));
			if (canonicalDirectory !== canonicalExpected)
				throw new WorkflowRuntimeError(
					"artifact",
					"artifact parent is outside the expected run directory",
				);
			directory = openSecureDirectory(
				canonicalDirectory,
				path.parse(canonicalDirectory).root,
				false,
			);
		}
		fd = openSecureFile(directory, path.basename(actual));
		const stat = fs.fstatSync(fd);
		if (!stat.isFile())
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact must be bounded regular non-symlink file",
			);
		const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_ARTIFACT_BYTES)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact must be bounded regular non-symlink file",
			);
		const bytes = buffer.subarray(0, bytesRead);
		// Parse while the descriptor is still tied to the no-follow directory.
		let envelope: unknown;
		try {
			envelope = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new WorkflowRuntimeError("artifact", "artifact is invalid JSON");
		}
		if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact envelope must be object",
			);
		const item = envelope as Record<string, unknown>;
		const schema = run.outputSchema;
		if (
			!schema ||
			item.runId !== run.id ||
			item.schemaId !== schema.id ||
			item.schemaVersion !== schema.version
		)
			throw new WorkflowRuntimeError(
				"artifact",
				"artifact run/schema identity mismatch",
			);
		return {
			output: item.payload,
			digest: createHash("sha256").update(bytes).digest("hex"),
		};
	} catch (error) {
		if (error instanceof WorkflowRuntimeError) throw error;
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact must be bounded regular non-symlink file",
		);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (directory !== undefined) fs.closeSync(directory);
		if (trusted !== undefined) fs.closeSync(trusted);
	}
}
