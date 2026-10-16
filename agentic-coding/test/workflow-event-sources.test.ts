// The bounded extra reads behind `verification.finished`, `compaction` and
// `openspec.task-progress` (add-orchestrator-event-subscriptions, task 1.4):
// real files in a temporary workflow tree, and the containment that keeps a
// store-derived id from reading outside it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import { enrichWorkflowEvent } from "../src/server/workflow-event-sources.ts";
import { projectWorkflowEvents } from "../src/server/workflow-events.ts";

function worktree(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-sources-"));
}

function view(
	root: string,
	overrides: Partial<WorkflowView> = {},
): WorkflowView {
	return {
		workflowId: "wf-1",
		changeId: "a-change",
		worktree: root,
		status: "active",
		startedBy: "orchestrator",
		currentStep: {
			id: "core.implementation",
			label: "core.implementation",
			attempt: 1,
			enteredAt: "",
		},
		runs: [],
		effects: [],
		health: { valid: true, attention: [] },
		availableActions: [],
		...overrides,
	} as unknown as WorkflowView;
}

function telemetry(root: string, workflowId: string, lines: string[]): void {
	const directory = path.join(root, ".herdr-workflow", workflowId);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "telemetry.jsonl"),
		`${lines.join("\n")}\n`,
	);
}

function tasks(root: string, changeId: string, body: string): void {
	const directory = path.join(root, "openspec", "changes", changeId);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "tasks.md"), body);
}

const compactionLine = (role: string, reason: string) =>
	JSON.stringify({
		event: "runtime.compaction",
		role,
		reason,
		tokensBefore: 1000,
		tokensAfter: 200,
	});

describe("enrichWorkflowEvent", () => {
	test("reads the compaction entries of the run's own telemetry and skips a malformed line", () => {
		const root = worktree();
		telemetry(root, "wf-1", [
			compactionLine("implementer", "context"),
			"{ not json",
			compactionLine("verifier", "budget"),
		]);
		const enriched = enrichWorkflowEvent({
			view: view(root),
			previous: projectWorkflowEvents(view(root)),
			next: projectWorkflowEvents(view(root)),
		});
		expect(enriched?.compaction).toHaveLength(2);
		expect(enriched?.compaction?.[0]).toMatchObject({
			role: "implementer",
			reason: "context",
		});
	});

	test("counts the change's task checkboxes", () => {
		const root = worktree();
		tasks(root, "a-change", "- [x] one\n- [ ] two\n- [X] three\n- [ ] four\n");
		const enriched = enrichWorkflowEvent({
			view: view(root),
			previous: projectWorkflowEvents(view(root)),
			next: projectWorkflowEvents(view(root)),
		});
		expect(enriched?.openspec).toEqual({
			changeId: "a-change",
			done: 2,
			total: 4,
		});
	});

	test("a missing telemetry file and a missing tasks artifact yield nothing", () => {
		const root = worktree();
		const enriched = enrichWorkflowEvent({
			view: view(root),
			previous: projectWorkflowEvents(view(root)),
			next: projectWorkflowEvents(view(root)),
		});
		expect(enriched).toBeUndefined();
	});

	test("a store-derived id that escapes the worktree is never read", () => {
		const root = worktree();
		// Files that a `..` id would reach if the path were not contained: one
		// directory above the worktree.
		const outside = path.join(path.dirname(root), "evil");
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(
			path.join(outside, "telemetry.jsonl"),
			`${compactionLine("implementer", "escaped")}\n`,
		);
		fs.writeFileSync(path.join(outside, "tasks.md"), "- [x] escaped\n");
		const escaping = view(root, {
			workflowId: "../../evil",
			changeId: "../../../evil",
		});
		const enriched = enrichWorkflowEvent({
			view: escaping,
			previous: projectWorkflowEvents(escaping),
			next: projectWorkflowEvents(escaping),
		});
		// Without `contained()` the `../../evil` id would resolve to these files
		// and both values would be defined: the two assertions above are the ones
		// that detect the escape.
		expect(enriched?.compaction).toBeUndefined();
		expect(enriched?.openspec).toBeUndefined();
	});
});

const compactionLine2 = (role: string, reason = "again") =>
	JSON.stringify({ event: "runtime.compaction", role, reason });

describe("the source caches", () => {
	test("a telemetry file that grew is re-read, and an absent one is not cached as a hit", () => {
		const root = worktree();
		telemetry(root, "wf-1", [compactionLine("implementer", "one")]);
		const first = enrichWorkflowEvent({
			view: view(root),
			previous: projectWorkflowEvents(view(root)),
			next: projectWorkflowEvents(view(root)),
		});
		expect(first?.compaction).toHaveLength(1);
		// The stamp (mtime + size) must notice the append: a stale cache would
		// silently drop every later compaction event.
		fs.appendFileSync(
			path.join(root, ".herdr-workflow", "wf-1", "telemetry.jsonl"),
			`${compactionLine2("verifier")}\n`,
		);
		const second = enrichWorkflowEvent({
			view: view(root),
			previous: projectWorkflowEvents(view(root)),
			next: projectWorkflowEvents(view(root)),
		});
		expect(second?.compaction).toHaveLength(2);
		// A file that appears after a miss is read on the next observation.
		const fresh = worktree();
		expect(
			enrichWorkflowEvent({
				view: view(fresh),
				previous: projectWorkflowEvents(view(fresh)),
				next: projectWorkflowEvents(view(fresh)),
			}),
		).toBeUndefined();
		telemetry(fresh, "wf-1", [compactionLine("implementer", "late")]);
		expect(
			enrichWorkflowEvent({
				view: view(fresh),
				previous: projectWorkflowEvents(view(fresh)),
				next: projectWorkflowEvents(view(fresh)),
			})?.compaction,
		).toHaveLength(1);
	});
});

describe("verification counts", () => {
	function findingsFile(
		role: string,
		findings: Array<{ severity: string }>,
	): {
		outputPath: string;
		outputDigest: string;
	} {
		const root = worktree();
		const outputPath = path.join(root, `${role}.json`);
		const bytes = Buffer.from(
			JSON.stringify({
				runId: `run-${role}`,
				schemaId: "core.findings",
				schemaVersion: 1,
				payload: {
					findings: findings.map((finding, index) => ({
						id: `${role}-${index}`,
						severity: finding.severity,
						detail: "found something",
					})),
				},
			}),
		);
		fs.writeFileSync(outputPath, bytes);
		return {
			outputPath,
			outputDigest: createHash("sha256").update(bytes).digest("hex"),
		};
	}

	function verifierView(
		root: string,
		runs: Array<{
			id: string;
			role: string;
			status: string;
			outputPath?: string;
			outputDigest?: string;
		}>,
	): WorkflowView {
		return view(root, {
			runs: runs.map((run) => ({
				id: run.id,
				stepId: "core.verification",
				role: run.role,
				attempt: 1,
				status: run.status,
				runtime: "pi-durable",
				profile: "default",
				...(run.outputPath ? { outputPath: run.outputPath } : {}),
				...(run.outputDigest ? { outputDigest: run.outputDigest } : {}),
			})),
		} as never);
	}

	test("each verifier role is mapped to its own committed counts", () => {
		const root = worktree();
		const quality = findingsFile("quality-verifier", [
			{ severity: "critical" },
			{ severity: "warning" },
		]);
		const security = findingsFile("security-verifier", [
			{ severity: "warning" },
			{ severity: "info" },
			{ severity: "info" },
		]);
		const withRuns = verifierView(root, [
			{
				id: "run-quality-verifier",
				role: "quality-verifier",
				status: "completed",
				...quality,
			},
			{
				id: "run-security-verifier",
				role: "security-verifier",
				status: "completed",
				...security,
			},
		]);
		const previous = projectWorkflowEvents(
			verifierView(root, [
				{
					id: "run-quality-verifier",
					role: "quality-verifier",
					status: "working",
				},
				{
					id: "run-security-verifier",
					role: "security-verifier",
					status: "working",
				},
			]),
		);
		const enriched = enrichWorkflowEvent({
			view: withRuns,
			previous,
			next: projectWorkflowEvents(withRuns),
		});
		expect(enriched?.verification).toEqual({
			"quality-verifier": { critical: 1, warning: 1, info: 0 },
			"security-verifier": { critical: 0, warning: 1, info: 2 },
		});
	});

	test("a completed run with no readable findings yields nothing, and no completion edge reads at all", () => {
		const root = worktree();
		const missing = verifierView(root, [
			{
				id: "run-verifier",
				role: "verifier",
				status: "completed",
				outputPath: path.join(root, "gone.json"),
				outputDigest: "0".repeat(64),
			},
		]);
		expect(
			enrichWorkflowEvent({
				view: missing,
				previous: projectWorkflowEvents(
					verifierView(root, [
						{ id: "run-verifier", role: "verifier", status: "working" },
					]),
				),
				next: projectWorkflowEvents(missing),
			})?.verification,
		).toBeUndefined();
		// No verification run completed in this observation: the source is not
		// read at all.
		const stillRunning = verifierView(root, [
			{ id: "run-verifier", role: "verifier", status: "working" },
		]);
		expect(
			enrichWorkflowEvent({
				view: stillRunning,
				previous: projectWorkflowEvents(stillRunning),
				next: projectWorkflowEvents(stillRunning),
			})?.verification,
		).toBeUndefined();
	});
});
