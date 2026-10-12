// The evidence routes (`add-workflow-evidence-store`, task 2.1): the
// owner-scoped attach/list surface, the instance-authenticated file route, the
// contract decoding of both bodies and the observation's bounded fields.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeContract } from "../src/contracts/decode.ts";
import {
	evidenceAttachRequestSchema,
	observeRequestSchema,
} from "../src/contracts/environment.ts";
import {
	EVIDENCE_AGENT_ATTACH_PATH,
	EVIDENCE_AGENT_LIST_PATH,
	handleEvidenceFileRoute,
	handleEvidenceRoute,
	readEvidenceBytes,
} from "../src/server/evidence/routes.ts";
import { decodeRouteRequest } from "../src/server/protocol.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const WORKFLOW_ID = "wf-alpha";
const OWNER = `workflow:${WORKFLOW_ID}`;
const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function fixture(): { worktree: string; scope: unknown } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-routes-"));
	const worktree = path.join(base, "repo");
	fs.mkdirSync(worktree, { recursive: true });
	return { worktree, scope: undefined };
}

const locateFor = (worktree: string | undefined) => (workflowId: string) =>
	workflowId === WORKFLOW_ID ? { workflowId, worktree } : undefined;

async function callAgentRoute(
	deps: Parameters<typeof handleEvidenceRoute>[0],
	method: string,
	routePath: string,
	options: { owner?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleEvidenceRoute(
		deps,
		new Request(url, {
			method,
			...(options.body === undefined
				? {}
				: {
						body: JSON.stringify(options.body),
						headers: { "content-type": "application/json" },
					}),
		}),
		new URL(url),
		options.owner ?? OWNER,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	return {
		status: response.status,
		body: JSON.parse(text) as Record<string, unknown>,
		text,
	};
}

describe("the owner-scoped evidence routes", () => {
	test("attach stores the file and list reads the manifest back", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const deps = { locate: locateFor(worktree) };
		const attached = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{
				body: {
					path: source,
					kind: "screenshot",
					caption: "checkout, empty cart",
					step: "core.implementation",
					role: "worker",
				},
			},
		);
		expect(attached.status).toBe(201);
		const entry = attached.body.value as Record<string, unknown>;
		expect(entry).toMatchObject({
			kind: "screenshot",
			caption: "checkout, empty cart",
			step: "core.implementation",
			role: "worker",
		});
		const listed = await callAgentRoute(deps, "GET", EVIDENCE_AGENT_LIST_PATH);
		expect(listed.status).toBe(200);
		const value = listed.body.value as {
			workflowId: string;
			entries: unknown[];
			quotaBytes: number;
		};
		expect(value.workflowId).toBe(WORKFLOW_ID);
		expect(value.entries).toHaveLength(1);
		expect(value.quotaBytes).toBeGreaterThan(0);
	});

	test("an attach outside the workflow's checkout is refused", async () => {
		const { worktree } = fixture();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-outside-"));
		const forbidden = path.join(outside, "passwd");
		fs.writeFileSync(forbidden, "root:x:0:0\n");
		const result = await callAgentRoute(
			{ locate: locateFor(worktree) },
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: forbidden, kind: "log", caption: "outside" } },
		);
		expect(result.status).toBe(400);
		expect((result.body.error as { code: string }).code).toBe("evidence-path");
	});

	test("the workflow comes from the verified owner, never the body", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const result = await callAgentRoute(
			{ locate: locateFor(worktree) },
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{
				body: {
					path: source,
					kind: "screenshot",
					caption: "x",
					workflowId: "other",
				},
			},
		);
		// An unknown field is rejected rather than smuggled past the boundary.
		expect(result.status).toBe(400);
		expect(result.text).toContain("workflowId");
	});

	test("a user owner has no evidence store", async () => {
		const result = await callAgentRoute(
			{ locate: locateFor(undefined) },
			"GET",
			EVIDENCE_AGENT_LIST_PATH,
			{ owner: "user" },
		);
		expect(result.status).toBe(403);
	});

	test("an unrecorded workflow is refused, not invented", async () => {
		const result = await callAgentRoute(
			{ locate: () => undefined },
			"GET",
			EVIDENCE_AGENT_LIST_PATH,
		);
		expect(result.status).toBe(404);
		expect((result.body.error as { code: string }).code).toBe(
			"evidence-missing",
		);
	});

	test("a path this module does not own is left to the caller", async () => {
		const response = await handleEvidenceRoute(
			{},
			new Request("http://127.0.0.1:4050/api/v1/agent-env/list"),
			new URL("http://127.0.0.1:4050/api/v1/agent-env/list"),
			OWNER,
		);
		expect(response).toBeUndefined();
	});
});

describe("the evidence file route", () => {
	test("serves one recorded entry with its content type", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const deps = { locate: locateFor(worktree) };
		const attached = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: source, kind: "screenshot", caption: "shot" } },
		);
		const entry = attached.body.value as { id: string };
		const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/${entry.id}`;
		const response = await handleEvidenceFileRoute(
			deps,
			new Request(url),
			new URL(url),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
	});

	test("the in-process dashboard read answers the same bytes as the file route", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const deps = { locate: locateFor(worktree) };
		const attached = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: source, kind: "screenshot", caption: "shot" } },
		);
		const entry = attached.body.value as { id: string };

		expect(await readEvidenceBytes(WORKFLOW_ID, entry.id, deps)).toEqual(
			new Uint8Array(PNG),
		);
		// An unknown entry, an unknown workflow and a workflow with no evidence
		// directory are all `undefined`: nothing to render is an answer.
		expect(
			await readEvidenceBytes(WORKFLOW_ID, "01JCAAAAAAAAAAAAAAAAAAAAAA", deps),
		).toBeUndefined();
		expect(await readEvidenceBytes("wf-other", entry.id, deps)).toBeUndefined();
	});

	test("an attach is refused once the workflow's workspace was cleaned", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		// The close order: `workspace.cleanup` removed the evidence directory while
		// the workflow record stayed, so locating it still answers — but a closed
		// workflow may not receive new evidence.
		const deps = {
			locate: (workflowId: string) =>
				workflowId === WORKFLOW_ID
					? { workflowId, worktree, status: "closed" as const }
					: undefined,
		};
		const refused = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: source, kind: "screenshot", caption: "late" } },
		);

		expect(refused.status).toBe(409);
		expect((refused.body.error as { code: string }).code).toBe(
			"evidence-missing",
		);
		expect(
			fs.existsSync(
				workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree }).root,
			),
		).toBe(false);
	});

	test("a stored file removed before the read is missing, not an empty body", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const deps = { locate: locateFor(worktree) };
		const attached = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: source, kind: "screenshot", caption: "gone" } },
		);
		const entry = attached.body.value as { id: string; file: string };
		fs.rmSync(
			path.join(
				workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree }).root,
				entry.file,
			),
		);

		const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/${entry.id}`;
		const response = await handleEvidenceFileRoute(
			deps,
			new Request(url),
			new URL(url),
		);
		// A gone file is a 404 the client maps to `undefined`, never a 200 with an
		// empty body that would be cached as an image.
		expect(response.status).toBe(404);
		expect(
			await readEvidenceBytes(WORKFLOW_ID, entry.id, deps),
		).toBeUndefined();
	});

	test("a stored file swapped for a symlink is refused, not followed", async () => {
		const { worktree } = fixture();
		const source = path.join(worktree, "shot.png");
		fs.writeFileSync(source, PNG);
		const deps = { locate: locateFor(worktree) };
		const attached = await callAgentRoute(
			deps,
			"POST",
			EVIDENCE_AGENT_ATTACH_PATH,
			{ body: { path: source, kind: "screenshot", caption: "swap" } },
		);
		const entry = attached.body.value as { id: string; file: string };
		const secret = path.join(worktree, "secret.txt");
		fs.writeFileSync(secret, "not evidence");
		const stored = path.join(
			workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree }).root,
			entry.file,
		);
		fs.rmSync(stored);
		fs.symlinkSync(secret, stored);

		const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/${entry.id}`;
		const response = await handleEvidenceFileRoute(
			deps,
			new Request(url),
			new URL(url),
		);
		expect(response.status).toBe(404);
		expect(
			await readEvidenceBytes(WORKFLOW_ID, entry.id, deps),
		).toBeUndefined();
	});

	test("an unknown id is not found, and a traversing id never reaches the disk", async () => {
		const { worktree } = fixture();
		const deps = { locate: locateFor(worktree) };
		for (const id of ["01JCAAAAAAAAAAAAAAAAAAAAAA", "..", "manifest.json"]) {
			const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/${id}`;
			const response = await handleEvidenceFileRoute(
				deps,
				new Request(url),
				new URL(url),
			);
			expect(response.status).toBe(404);
		}
	});

	test("a non-get method is not a route", async () => {
		const url = `http://127.0.0.1:4050/api/v1/evidence/${WORKFLOW_ID}/anything`;
		const response = await handleEvidenceFileRoute(
			{ locate: locateFor(undefined) },
			new Request(url, { method: "POST" }),
			new URL(url),
		);
		expect(response.status).toBe(404);
	});
});

describe("evidence contracts", () => {
	test("the observation decodes with an optional request id", () => {
		expect(
			decodeContract("test.observe.evidence", observeRequestSchema, {
				observation: {
					kind: "evidence",
					repo: "/repos/shop",
					workflowId: WORKFLOW_ID,
				},
			}),
		).toMatchObject({ observation: { kind: "evidence" } });
		expect(
			decodeContract("test.observe.evidence", observeRequestSchema, {
				observation: {
					kind: "evidence",
					repo: "/repos/shop",
					workflowId: WORKFLOW_ID,
					requestId: "42",
				},
			}),
		).toMatchObject({ observation: { requestId: "42" } });
	});

	test("an unknown kind is not evidence", () => {
		expect(() =>
			decodeContract("test.observe.evidence", observeRequestSchema, {
				observation: { kind: "evidence ", repo: "/repos/shop" },
			}),
		).toThrow();
	});

	test("the attach body is registered and bounded", () => {
		const url = EVIDENCE_AGENT_ATTACH_PATH;
		expect(() =>
			decodeRouteRequest(url, {
				path: "/tmp/shot.png",
				kind: "screenshot",
				caption: "shot",
			}),
		).not.toThrow();
		expect(() =>
			decodeRouteRequest(url, {
				path: "/tmp/shot.png",
				kind: "poster",
				caption: "shot",
			}),
		).toThrow();
		expect(() =>
			decodeRouteRequest(url, {
				path: "/tmp/shot.png",
				kind: "screenshot",
				caption: "x".repeat(513),
			}),
		).toThrow();
		expect(() =>
			decodeRouteRequest(url, {
				path: "/tmp/shot.png",
				kind: "screenshot",
				caption: "bad\u0000caption",
			}),
		).toThrow();
		expect(() =>
			decodeRouteRequest(url, { kind: "screenshot", caption: "shot" }),
		).toThrow();
	});

	test("the schema itself rejects an unstorable kind", () => {
		expect(() =>
			decodeContract("test.attach", evidenceAttachRequestSchema, {
				path: "/tmp/shot.png",
				kind: "webm",
				caption: "shot",
			}),
		).toThrow();
	});
});
