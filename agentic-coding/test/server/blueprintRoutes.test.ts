// add-orchestrator-blueprint-workflows: the blueprint read/validate routes,
// the orchestrator's allowlist for them, and the start route's blueprint
// alternative. Runs a real loopback server; the read/validate routes use the
// real (pure) blueprint operations, and `start` is recorded so the transport's
// decision is visible without compiling a workflow.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { orchestratorTokenFor } from "../../src/server/auth.ts";
import { BackendClient } from "../../src/server/client.ts";
import {
	type ServerOperations,
	serverOperations,
} from "../../src/server/handlers.ts";
import { startWorkflowServer } from "../../src/server/lifecycle.ts";
import { BLUEPRINT_STEP_CATALOG } from "../../src/workflow/blueprints/index.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "../support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

/** A valid logical blueprint: one implementation agent, then completion. The
 * compiler inserts the per-step routing step (and nothing else, because the
 * graph has no gated stage and never verifies). */
function soloBlueprint(): Record<string, unknown> {
	return {
		label: "Solo task",
		rationale: "One implementation agent, start to finish.",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "none",
			startRequirements: ["task"],
			openspecVerifier: false,
		},
		verificationRounds: 6,
		steps: ["core.implementation", "core.completed", "core.closed"],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.completed",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	};
}

/** A blueprint that bypasses developer review: verification hands straight off
 * to delivery, so the compiler refuses it. */
function reviewFreeBlueprint(): Record<string, unknown> {
	return {
		label: "Review-free delivery",
		rationale: "Verification hands straight off.",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "pull-request",
			startRequirements: ["task"],
			openspecVerifier: false,
		},
		verificationRounds: 6,
		steps: [
			"core.implementation",
			"core.verification",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.verification",
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.delivery",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.delivery",
				outcome: "complete",
				to: "core.completed",
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	};
}

interface Calls {
	readonly starts: Array<{ request: unknown; options: unknown }>;
}

function operations(calls: Calls): ServerOperations {
	return {
		...serverOperations,
		start: async (request, options) => {
			calls.starts.push({ request, options });
			return `started ${request.workflowId}`;
		},
	};
}

async function withServer<T>(
	run: (
		server: Awaited<ReturnType<typeof startWorkflowServer>>,
		calls: Calls,
	) => Promise<T>,
): Promise<T> {
	const calls: Calls = { starts: [] };
	const server = await startWorkflowServer({ operations: operations(calls) });
	try {
		return await run(server, calls);
	} finally {
		await server.stop();
	}
}

const post = (token: string, body: unknown): RequestInit => ({
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify(body),
});

const get = (token: string): RequestInit => ({
	method: "GET",
	headers: { authorization: `Bearer ${token}` },
});

async function value<T>(response: Response): Promise<T> {
	expect(response.status).toBe(200);
	return ((await response.json()) as { value: T }).value;
}

describe("blueprint routes", () => {
	test("the step catalog is served to the operator and the orchestrator", async () => {
		await withServer(async (server) => {
			for (const token of [server.token, orchestratorTokenFor(server.token)]) {
				const catalog = await value<Array<{ id: string; description: string }>>(
					await fetch(`${server.url}/api/v1/workflow/steps`, get(token)),
				);
				// The catalog is exactly the compiler's logical allowlist, with a
				// description for every entry.
				expect(catalog.map((entry) => entry.id)).toEqual(
					BLUEPRINT_STEP_CATALOG.map((entry) => entry.id),
				);
				for (const entry of catalog)
					expect(entry.description.length).toBeGreaterThan(0);
			}
			// The typed client decodes the same catalog.
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "blueprint-test",
			});
			expect((await client.blueprintSteps()).length).toBe(
				BLUEPRINT_STEP_CATALOG.length,
			);
		});
	});

	test("validate compiles without side effects and answers diagnostics for a rejected shape", async () => {
		const repo = createTempRepoFixture(
			"blueprint-validate-",
			repoPreset.readme,
		);
		await withServer(async (server) => {
			const valid = await value<{
				ok: boolean;
				digest?: string;
				summary?: { steps: string[]; stepCount: number };
				diagnostics: unknown[];
			}>(
				await fetch(
					`${server.url}/api/v1/workflow/blueprint/validate`,
					post(server.token, { blueprint: soloBlueprint() }),
				),
			);
			expect(valid.ok).toBe(true);
			expect(valid.digest).toBeTruthy();
			// The summary reports the compiled graph, including the routing step
			// the compiler inserted.
			expect(valid.summary?.steps).toContain("core.route-implementation");
			expect(valid.summary?.stepCount).toBeGreaterThan(3);
			expect(valid.diagnostics).toEqual([]);

			const refused = await value<{
				ok: boolean;
				digest?: string;
				summary?: unknown;
				diagnostics: Array<{ rule: string; message: string }>;
			}>(
				await fetch(
					`${server.url}/api/v1/workflow/blueprint/validate`,
					post(server.token, { blueprint: reviewFreeBlueprint() }),
				),
			);
			expect(refused.ok).toBe(false);
			expect(refused.digest).toBeUndefined();
			expect(refused.summary).toBeUndefined();
			expect(
				refused.diagnostics.map((diagnostic) => diagnostic.rule),
			).toContain("review.implementation-review");

			// An undecodable document is answered with a schema diagnostic, not a
			// malformed-request error: the model author can fix it.
			const undecodable = await value<{
				ok: boolean;
				diagnostics: Array<{ rule: string }>;
			}>(
				await fetch(
					`${server.url}/api/v1/workflow/blueprint/validate`,
					post(server.token, { blueprint: { nope: true } }),
				),
			);
			expect(undecodable.ok).toBe(false);
			expect(undecodable.diagnostics[0]?.rule).toBe("schema");
		});
		// Validation names no repository and writes nothing; the fixture the
		// caller would have passed is untouched.
		expect(fs.existsSync(path.join(repo, ".herdr-workflow"))).toBe(false);
	});

	test("the orchestrator validates and starts a blueprint, keeping the gate pin", async () => {
		await withServer(async (server, calls) => {
			const token = orchestratorTokenFor(server.token);
			const validation = await value<{ ok: boolean; digest?: string }>(
				await fetch(
					`${server.url}/api/v1/workflow/blueprint/validate`,
					post(token, { blueprint: soloBlueprint() }),
				),
			);
			expect(validation.ok).toBe(true);

			const started = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(token, {
					repo: "/repos/shop",
					workflowId: "blueprint-1",
					mode: "worktree",
					task: "fix the flag",
					blueprint: soloBlueprint(),
				}),
			);
			expect(started.status).toBe(200);
			expect(calls.starts).toHaveLength(1);
			const call = calls.starts[0] as {
				request: { blueprint?: unknown; workflowType?: string };
				options: unknown;
			};
			expect(call.request.blueprint).toEqual(soloBlueprint());
			expect(call.request.workflowType).toBeUndefined();
			// The server, not the model, decides the gate pin and the attribution.
			expect(call.options).toEqual({
				enforceHumanReviewGates: true,
				principal: "orchestrator",
			});
		});
	});

	test("a start that names a workflow type and a blueprint is refused as malformed", async () => {
		await withServer(async (server, calls) => {
			const response = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, {
					repo: "/repos/shop",
					workflowId: "ambiguous",
					mode: "worktree",
					task: "fix the flag",
					workflowType: "openspec",
					blueprint: soloBlueprint(),
				}),
			);
			expect(response.status).toBe(400);
			expect(calls.starts).toEqual([]);
		});
	});

	test("a start with neither shape keeps the historical built-in default", async () => {
		// Backward compatibility, deliberately: a start has always defaulted to
		// the `openspec` family when it named no type, and both adapters and the
		// dashboard launch form rely on it. Only naming *both* is malformed.
		await withServer(async (server, calls) => {
			const response = await fetch(
				`${server.url}/api/v1/workflow/start`,
				post(server.token, {
					repo: "/repos/shop",
					workflowId: "defaulted",
					mode: "worktree",
					task: "fix the flag",
				}),
			);
			expect(response.status).toBe(200);
			expect(calls.starts).toHaveLength(1);
		});
	});

	test("the typed client decodes a validation answer", async () => {
		await withServer(async (server) => {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "blueprint-client",
			});
			const valid = await client.validateBlueprint(soloBlueprint());
			expect(valid.ok).toBe(true);
			expect(valid.summary?.label).toBe("Solo task");
			const refused = await client.validateBlueprint(reviewFreeBlueprint());
			expect(refused.ok).toBe(false);
			expect(refused.diagnostics.length).toBeGreaterThan(0);
		});
	});
});
