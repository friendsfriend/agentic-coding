import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serve } from "../src/server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("bounded retained history reports omissions while older exact IDs remain run-scoped without redispatch", async () => {
	const requests: string[] = [],
		endpoint = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				requests.push(pathname);
				return new Response(pathname, {
					headers: { "content-type": "text/plain" },
				});
			},
		});
	try {
		const { app, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: config.repositories[0],
							targets: [
								{
									id: "serve",
									action: "run",
									runtime: "shell",
									command: "printf 'READY\\n'; sleep 120",
									readyText: "READY",
									endpoints: { web: `http://127.0.0.1:${endpoint.port}` },
								},
							],
						},
					],
				}),
			);
		});
		const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
		// One entry beyond the list boundary, then one append while paging.
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			...Array.from({ length: 202 }, (_, index) =>
				call("env_http_get", {
					app: "api",
					endpoint: "web",
					path: `/history-${index}`,
				}),
			),
			call("env_stop", { apps: ["api"] }),
			call("env_start", { apps: ["api"] }),
			call("env_http_get", { app: "api", endpoint: "web", path: "/later-run" }),
			fauxAssistantMessage("Done"),
		]);
		const host = serve(app);
		try {
			const base = new URL(host.url),
				token = new URLSearchParams(base.hash.slice(1)).get("token"),
				get = (run: string, operation?: string, cursor?: string) => {
					const query = new URLSearchParams({ run });
					if (operation !== undefined) query.set("operation", operation);
					if (cursor !== undefined) query.set("cursor", cursor);
					return fetch(
						new URL(`/api/environments/http-history?${query}`, base),
						{ headers: { Authorization: `Bearer ${token}` } },
					);
				},
				task = await app.startTask(invocation);
			await approve(app, task);
			await pendingReview(app, task, "Endpoint GET: api/web");
			const firstRun = (await app.environments.snapshot()).runs[0];
			if (!firstRun) throw new Error("First native run missing");
			expect(await (await get(firstRun.id)).json()).toMatchObject({
				records: [],
				total: 0,
				returned: 0,
				omitted: 0,
				limit: 200,
			});
			await approve(app, task, "Endpoint GET: api/web");
			await pendingReview(app, task, "Endpoint GET: api/web");
			const initial = await (await get(firstRun.id)).json(),
				oldest = initial.records[0].id;
			for (let index = 1; index < 201; index++)
				await approve(app, task, "Endpoint GET: api/web");
			await pendingReview(app, task, "Endpoint GET: api/web");
			const history = await (await get(firstRun.id)).json();
			expect(history).toMatchObject({
				total: 201,
				returned: 200,
				limit: 200,
				omitted: 1,
				scope: "exact-run",
				order: "newest-issuance-first",
			});
			expect(
				history.records.some((entry: { id: string }) => entry.id === oldest),
			).toBe(false);
			expect(await (await get(firstRun.id, oldest)).json()).toMatchObject({
				id: oldest,
				run: firstRun.id,
				state: "completed",
				result: { body: "/history-0" },
			});
			// Append to the same run after saving the first page's boundary.
			await approve(app, task, "Endpoint GET: api/web");
			await approve(app, task); // Later startup; stop uses existing cleanup authority.
			await approve(app, task, "Endpoint GET: api/web");
			await app.harness.waitForTask(task as TaskId, context);
			const older = await (
				await get(firstRun.id, undefined, history.nextCursor)
			).json();
			expect(older).toMatchObject({
				total: 202,
				returned: 1,
				newer: 201,
				remainingOlder: 0,
				nextCursor: null,
			});
			expect(older.records[0].id).toBe(oldest);
			expect(
				new Set(
					[...history.records, ...older.records].map(
						(record: { id: string }) => record.id,
					),
				).size,
			).toBe(201);
			expect(await (await get(firstRun.id)).json()).toMatchObject({
				total: 202,
				returned: 200,
				newer: 0,
				remainingOlder: 2,
			});
			expect((await get(firstRun.id, oldest, history.nextCursor)).status).toBe(
				400,
			);
			expect((await get(firstRun.id, undefined, "0".repeat(64))).status).toBe(
				400,
			);
			const secondRun = (await app.environments.snapshot()).runs.find(
				(run) => run.id !== firstRun.id,
			);
			if (!secondRun) throw new Error("Later native run missing");
			expect(await (await get(secondRun.id)).json()).toMatchObject({
				total: 1,
				returned: 1,
				omitted: 0,
			});
			expect((await get(secondRun.id, oldest)).status).toBe(400);
			expect(
				(await get(secondRun.id, undefined, history.nextCursor)).status,
			).toBe(400);
			expect((await get(firstRun.id, "__proto__")).status).toBe(400);
			expect(requests).toEqual([
				...Array.from({ length: 202 }, (_, index) => `/history-${index}`),
				"/later-run",
			]);
		} finally {
			host.stop();
		}
	} finally {
		endpoint.stop(true);
	}
}, 120000);
