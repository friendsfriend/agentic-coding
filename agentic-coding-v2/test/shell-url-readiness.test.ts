import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { git } from "../src/git.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

for (const occupied of [false, true])
	test(`native shell HTTP readiness ${occupied ? "refuses existing listeners without spawning" : "observes the approved live child and closes with it"}`, async () => {
		const allocator = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null, { status: 204 }),
		});
		const url = `http://127.0.0.1:${allocator.port}/ready`;
		if (!occupied) await allocator.stop(true);
		try {
			const { app, fake, invocation } = await fixture(false, (config) => {
				fs.mkdirSync(config.configDir, { recursive: true });
				fs.writeFileSync(
					path.join(config.configDir, "environments.json"),
					JSON.stringify({
						version: 1,
						projects: [
							{
								id: "web",
								kind: "app",
								repository: config.repositories[0],
								targets: [
									{
										id: "serve",
										action: "run",
										runtime: "shell",
										command: `${JSON.stringify(process.execPath)} owned-http.ts`,
										readyUrl: url,
										environment: { FIXTURE_PORT: String(new URL(url).port) },
										timeoutMs: 3000,
									},
								],
							},
						],
					}),
				);
			});
			fs.writeFileSync(
				path.join(invocation.repository, "owned-http.ts"),
				'import fs from "node:fs"; fs.writeFileSync("started.marker", "spawned"); Bun.serve({hostname:"127.0.0.1",port:Number(process.env.FIXTURE_PORT),fetch:()=>new Response(null,{status:204})}); setInterval(()=>{},1000);',
			);
			await git(invocation.repository, ["add", "owned-http.ts"]);
			await git(invocation.repository, [
				"commit",
				"-m",
				"Disposable owned readiness fixture",
			]);
			fake.setResponses([
				call("env_start", { apps: ["web"] }),
				call("request_review", { path: ".", title: "Readiness result" }),
			]);
			const task = await app.startTask(invocation);
			const review = await pendingReview(app, task);
			expect(review.snapshot).toContain(url);
			await approve(app, task);
			await pendingReview(app, task, "Readiness result");
			const run = (await app.environments.snapshot()).runs[0];
			if (occupied) {
				expect(run?.ready).not.toBe(true);
				expect(
					fs.existsSync(
						path.join(
							run?.plan.workspace ?? invocation.repository,
							"started.marker",
						),
					),
				).toBe(false);
			} else {
				expect(run?.ready).toBe(true);
				expect((await fetch(url)).status).toBe(204);
			}
			await app.cancel(task);
			if (!occupied) {
				let closed = false;
				try {
					await fetch(url, { signal: AbortSignal.timeout(500) });
				} catch {
					closed = true;
				}
				expect(closed).toBe(true);
			} else expect((await fetch(url)).status).toBe(204);
		} finally {
			await allocator.stop(true);
		}
	}, 15000);
