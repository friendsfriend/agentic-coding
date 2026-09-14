// Server-owned telemetry boundary tests (expose-unified-bun-backend, task 2.3):
// the server scans workspaces into its own SQLite database and serves typed
// snapshot/scan/prune queries; the client never opens the database.
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
	test("scans a workspace into the server database and serves a snapshot", async () => {
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
			const snapshot = await client.telemetrySnapshot();
			expect(snapshot.workspaces.some((item) => item.changeId === "wf-1")).toBe(
				true,
			);
			expect(snapshot.spans.length).toBeGreaterThan(0);
			expect(await client.telemetryPrune(30)).toBeGreaterThanOrEqual(0);
		} finally {
			await server.stop();
		}
	});

	test("telemetry routes require the instance capability", async () => {
		const server = await startWorkflowServer({ telemetryDbPath: tempDir() });
		try {
			const denied = await fetch(`${server.url}/api/v1/telemetry/snapshot`);
			expect(denied.status).toBe(401);
		} finally {
			await server.stop();
		}
	});

	test("telemetry routes report 503 when the server owns no telemetry service", async () => {
		const server = await startWorkflowServer({});
		try {
			const response = await fetch(`${server.url}/api/v1/telemetry/snapshot`, {
				headers: { authorization: `Bearer ${server.token}` },
			});
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
		} finally {
			await receivers.stop();
		}
	});

	test("an injected telemetry service receives scan and prune calls", async () => {
		const calls: string[] = [];
		const telemetry: TelemetryOperations = {
			snapshot: () => ({
				workspaces: [],
				spansByChange: {},
				spans: [],
				metrics: [],
				logs: [],
			}),
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

	test("the remote proxy reads the server snapshot and notifies watchers", async () => {
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
			const notified: string[] = [];
			const unwatch = db.watchWorkspaces(repo, (changeId) => {
				notified.push(changeId);
			});
			await db.scanAllWorkspacesAsync(repo);
			expect(db.getWorkspaces().map((item) => item.changeId)).toContain("wf-1");
			expect(db.loadSpans("wf-1").length).toBeGreaterThan(0);
			expect(db.loadSpans().length).toBeGreaterThan(0);
			expect(notified).toContain("wf-1");
			unwatch();
			db.close();
		} finally {
			await server.stop();
		}
	});
});
