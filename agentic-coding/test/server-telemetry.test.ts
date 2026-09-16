// Server-owned telemetry boundary tests (expose-unified-bun-backend, task 2.3):
// the server scans workspaces into its own SQLite database and serves the paged
// trace list, per-workflow span reads, workspaces, watch and prune over the
// authenticated API; the client never opens the database.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendClient } from "../src/server/client.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { startTelemetryReceivers } from "../src/server/receivers.ts";
import type { TelemetryOperations } from "../src/server/telemetry.ts";
import { RemoteTelemetryDb } from "../src/tui/otel/model/remote-db.ts";

const TELEMETRY = [
	'{"schemaVersion":1,"at":"2026-09-11T09:14:15.921Z","layer":"engine","event":"effect.result","workflowId":"wf-1","stepId":"core.implementation","role":"worker","outcome":"error","durationMs":250,"traceparent":"00-a3bc231c2fb909c7dc3fdf4a55f6aa7e-dd7779c4a8490e79-01"}',
	'{"schemaVersion":1,"at":"2026-09-11T09:14:16.247Z","layer":"runtime","runtime":"pi","event":"runtime.usage","workflowId":"wf-1","role":"worker","inputTokens":100,"outputTokens":20}',
].join("\n");

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "server-telemetry-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fakeRepo(): string {
	const repo = tempDir();
	const workflowDir = join(repo, ".herdr-workflow", "wf-1");
	mkdirSync(workflowDir, { recursive: true });
	writeFileSync(join(workflowDir, "telemetry.jsonl"), `${TELEMETRY}\n`);
	return repo;
}

describe("server-owned telemetry", () => {
	test("scans a workspace into the server database and serves a trace page", async () => {
		const repo = fakeRepo();
		const server = await startWorkflowServer({ telemetryDbPath: tempDir() });
		try {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "test-owner",
			});
			const scanned = await client.telemetryScan(repo);
			expect(scanned).toBeGreaterThan(0);
			const workspaces = await client.telemetryWorkspaces();
			expect(workspaces.some((item) => item.changeId === "wf-1")).toBe(true);
			// The list is one page of aggregated rows, and spans follow per workflow.
			const page = await client.telemetryTraces({ page: 1, perPage: 10 });
			expect(page.total).toBe(1);
			expect(page.items[0]?.changeId).toBe("wf-1");
			expect(page.items[0]?.spanCount).toBeGreaterThan(0);
			const spans = await client.telemetrySpans({ changeId: "wf-1" });
			expect(spans.length).toBeGreaterThan(0);
			const recent = await client.telemetrySpans({ limit: 10 });
			expect(recent.length).toBeGreaterThan(0);
			expect(await client.telemetryPrune(30)).toBeGreaterThanOrEqual(0);
		} finally {
			await server.stop();
		}
	});

	test("telemetry routes require the instance capability", async () => {
		const server = await startWorkflowServer({ telemetryDbPath: tempDir() });
		try {
			const denied = await fetch(`${server.url}/api/v1/telemetry/workspaces`);
			expect(denied.status).toBe(401);
		} finally {
			await server.stop();
		}
	});

	test("telemetry routes report 503 when the server owns no telemetry service", async () => {
		const server = await startWorkflowServer({});
		try {
			const response = await fetch(
				`${server.url}/api/v1/telemetry/workspaces`,
				{
					headers: { authorization: `Bearer ${server.token}` },
				},
			);
			expect(response.status).toBe(503);
		} finally {
			await server.stop();
		}
	});

	test("server-owned receivers route OTLP HTTP spans into the sink", async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const port = probe.port ?? 0;
		await probe.stop(true);
		const spans: unknown[] = [];
		const receivers = await startTelemetryReceivers(
			{ httpPort: port },
			{
				pushTraces: (batch) => spans.push(...batch),
				pushMetrics: () => {},
				pushLogs: () => {},
			},
		);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					resourceSpans: [
						{
							scopeSpans: [
								{
									spans: [
										{
											name: "smoke",
											traceId: "a".repeat(32),
											spanId: "b".repeat(16),
											startTimeUnixNano: "1000000000",
											endTimeUnixNano: "2000000000",
										},
									],
								},
							],
						},
					],
				}),
			});
			expect(response.ok).toBe(true);
			expect(spans.length).toBeGreaterThan(0);

			// The receiver owns the payload-size limit: a body over its 5 MB cap is
			// rejected with 413 and never reaches the sink.
			const accepted = spans.length;
			const oversized = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "x".repeat(5_100_000),
			});
			expect(oversized.status).toBe(413);
			expect(await oversized.text()).toContain("payload too large");
			expect(spans.length).toBe(accepted);
		} finally {
			await receivers.stop();
		}
	});

	test("an injected telemetry service receives scan and prune calls", async () => {
		const calls: string[] = [];
		const telemetry: TelemetryOperations = {
			summaries: () => ({ items: [], total: 0, page: 1, perPage: 50 }),
			workspaces: () => [],
			traceSpans: () => [],
			recentSpans: () => [],
			scan: async (repo) => {
				calls.push(`scan:${repo}`);
				return 3;
			},
			prune: (days) => {
				calls.push(`prune:${days}`);
				return 1;
			},
		};
		const server = await startWorkflowServer({ telemetry });
		try {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "test-owner",
			});
			expect(await client.telemetryScan("/repo")).toBe(3);
			expect(await client.telemetryPrune(7)).toBe(1);
			expect(calls).toEqual(["scan:/repo", "prune:7"]);
		} finally {
			await server.stop();
		}
	});

	test("scanning a repository refreshes the cached workspace list and invites a re-read", async () => {
		const repo = fakeRepo();
		const calls: string[] = [];
		const telemetry: TelemetryOperations = {
			summaries: () => {
				calls.push("summaries");
				return { items: [], total: 0, page: 1, perPage: 50 };
			},
			workspaces: () => [
				{
					changeId: "wf-1",
					path: `${repo}/.herdr-workflow/wf-1`,
					spanCount: 3,
				},
			],
			traceSpans: () => [],
			recentSpans: () => [],
			scan: async (repo) => {
				calls.push(`scan:${repo}`);
				if (repo === "/broken") throw new Error("scan failed");
				return 3;
			},
			prune: () => 0,
		};
		const server = await startWorkflowServer({ telemetry });
		try {
			const db = new RemoteTelemetryDb();
			db.setClient(
				new BackendClient({
					baseUrl: server.url,
					token: server.token,
					ownerId: "test-owner",
				}),
			);
			let changes = 0;
			const unsubscribe = db.onChange(() => {
				changes += 1;
			});
			// One scan per distinct root — no repeated history download.
			expect(await db.scanRepositories(["/one", "/two", "/one"])).toBe(6);

			expect(calls).toEqual(["scan:/one", "scan:/two"]);
			calls.length = 0;
			expect(db.getWorkspaces().map((item) => item.changeId)).toEqual(["wf-1"]);
			expect(changes).toBeGreaterThan(0);
			calls.length = 0;
			expect(await db.scanRepositories([])).toBe(0);
			expect(calls).toEqual([]);
			await expect(db.scanRepositories(["/broken"])).rejects.toThrow();
			expect(calls).toEqual(["scan:/broken"]);
			unsubscribe();
			db.close();
		} finally {
			await server.stop();
		}
	});

	test("the remote proxy reads pages and spans on demand and notifies watchers", async () => {
		const repo = fakeRepo();
		const server = await startWorkflowServer({ telemetryDbPath: tempDir() });
		try {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "test-owner",
			});
			const db = new RemoteTelemetryDb();
			db.setClient(client);
			const changes: string[] = [];
			const unsubscribe = db.onChange(() => changes.push("changed"));
			// Boot announces the repository without ingesting it: the page read is
			// what pulls data, and only for the page the view shows.
			await db.watchRepositories([repo]);
			await db.scanRepositories([repo]);
			expect(db.getWorkspaces().map((item) => item.changeId)).toContain("wf-1");
			const page = await db.fetchTracePage({ page: 1, perPage: 10 });
			expect(page.items.map((item) => item.changeId)).toEqual(["wf-1"]);
			expect((await db.fetchTraceSpans("wf-1")).length).toBeGreaterThan(0);
			expect((await db.fetchRecentSpans(10)).length).toBeGreaterThan(0);
			expect(changes.length).toBeGreaterThan(0);
			unsubscribe();
			db.close();
		} finally {
			await server.stop();
		}
	});
});
