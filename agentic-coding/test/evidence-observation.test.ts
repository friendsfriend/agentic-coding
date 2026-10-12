// The evidence observation and its file route (`add-workflow-evidence-store`,
// task 2.1): a real workflow's manifest is read back through the dashboard's
// observation, and the same workflow id locates the store the file route serves
// from — never a path a request supplied.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	handleEvidenceFileRoute,
	locateEvidenceWorkflow,
} from "../src/server/evidence/routes.ts";
import { attachEvidence } from "../src/server/evidence/store.ts";
import { runLocalObservation } from "../src/server/operations/observations.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

const WORKFLOW_ID = "evidence-workflow";
const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const profile = {
	name: "test",
	runtime: "pi-durable" as const,
	executable: "sh",
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"] as const,
	digest: "profile",
};

describe("the evidence observation", () => {
	test("a started workflow's manifest is readable through the observation", async () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "evidence-observation-"),
		);
		try {
			createRepoFixture(repo);
			const started = new WorkflowEngine(registerBuiltins()).start({
				repo,
				workflowId: WORKFLOW_ID,
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: {
					defaultProfile: "test",
					routes: [
						{ stepId: "core.implementation", role: "worker", profile },
						{ stepId: "core.triage", role: "triage", profile },
						{ stepId: "core.verification", profile },
					],
					diversity: [],
				},
			}).view;
			const scope = workflowEvidenceScope({
				workflowId: WORKFLOW_ID,
				worktree: started.worktree,
				definitionId: started.definition.id,
			});
			const source = path.join(started.worktree, "shot.png");
			fs.writeFileSync(source, PNG);
			const entry = await attachEvidence(scope, {
				path: source,
				kind: "screenshot",
				caption: "the checkout with an empty cart",
				step: "core.implementation",
				role: "worker",
			});

			const manifest = (await runLocalObservation({
				kind: "evidence",
				repo,
				workflowId: WORKFLOW_ID,
			})) as {
				workflowId: string;
				entries: Array<Record<string, unknown>>;
				bytes: number;
				quotaBytes: number;
			};
			expect(manifest.workflowId).toBe(WORKFLOW_ID);
			expect(manifest.entries).toHaveLength(1);
			expect(manifest.entries[0]).toMatchObject({
				id: entry.id,
				kind: "screenshot",
				caption: "the checkout with an empty cart",
				step: "core.implementation",
				role: "worker",
			});
			expect(manifest.bytes).toBe(PNG.length);
			expect(manifest.quotaBytes).toBeGreaterThan(manifest.bytes);

			// The file route locates the same store from the workflow id alone and
			// serves the recorded bytes.
			expect(locateEvidenceWorkflow(WORKFLOW_ID)?.worktree).toBe(
				started.worktree,
			);
			const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/${entry.id}`;
			const response = await handleEvidenceFileRoute(
				{},
				new Request(url),
				new URL(url),
			);
			expect(response.status).toBe(200);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
