import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
for (const profile of ["QA-Ivy", "qa.ivy_local"])
	test(`native exact profile ${profile} survives catalog, approval and execution without case-folded fallback`, async () => {
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
									runtime: "shell",
									action: "run",
									profile,
									readyText: "READY",
									command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('READY');setInterval(()=>{},1000)")}`,
								},
							],
						},
					],
				}),
			);
		});
		fake.setResponses([
			call("env_start", { apps: ["api"], profile }),
			call("env_start", { apps: ["api"], profile: profile.toUpperCase() }),
			call("request_review", { title: "Exact profile held", path: "." }),
		]);
		const task = await app.startTask(invocation),
			review = await pendingReview(app, task);
		expect(JSON.parse(review.snapshot).plans[0].profile).toBe(profile);
		expect((await app.environments.snapshot("api")).runs).toHaveLength(0);
		await approve(app, task);
		await pendingReview(app, task, "Exact profile held");
		const runs = (await app.environments.snapshot("api")).runs;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.plan.profile).toBe(profile);
		expect(runs[0]?.state).toBe("running");
		expect(runs[0]?.ready).toBe(true);
		await app.cancel(task);
	});
for (const collision of [false, true])
	test(`offline source profile ${collision ? "canonical ID collision refuses both sources without overwrite" : "preserves case, native default ID and authenticated saved-input acceptance"}`, async () => {
		const { app, config } = await fixture(true, (config) => {
			fs.mkdirSync(config.configDir);
			fs.chmodSync(config.stateDir, 0o700);
		});
		const root = path.dirname(config.configDir),
			source = path.join(root, "profile-source"),
			output = path.join(root, "profile-preview"),
			base = JSON.stringify({
				version: 1,
				projects: [
					{
						id: "demo",
						kind: "app",
						repository: config.repositories[0],
						targets: [],
					},
				],
			});
		for (const directory of ["apps/compose", "apps/build", "apps/defaults"])
			fs.mkdirSync(path.join(source, directory), { recursive: true });
		fs.writeFileSync(
			path.join(config.configDir, "config.json"),
			JSON.stringify({ profiles: {}, repositories: config.repositories }),
		);
		fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
		const text =
			"services:\n  app:\n    image: fixture:latest\n    networks: [local]\nnetworks:\n  local:\n    driver: bridge\n";
		fs.writeFileSync(
			path.join(source, "apps/compose/demo-QA-Ivy-compose.yml"),
			text,
		);
		if (collision)
			fs.writeFileSync(
				path.join(source, "apps/compose/demo-QA.Ivy-compose.yml"),
				text,
			);
		fs.writeFileSync(
			path.join(source, "apps/defaults/demo.json"),
			JSON.stringify({ run: "app/demo/run/docker/QA-Ivy" }),
		);
		const result = Bun.spawnSync(
			[
				process.execPath,
				path.join(
					import.meta.dir,
					"../scripts/preview-environment-migration.ts",
				),
				"--source-config",
				source,
				"--source-tree",
				source,
				"--current-config",
				config.configDir,
				"--socket",
				"/tmp/acv2-profile-test.sock",
				"--output",
				output,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(
				fs.readFileSync(path.join(output, "report.json"), "utf8"),
			),
			content = fs.readFileSync(path.join(output, "environments.json"), "utf8"),
			project = JSON.parse(content).projects[0];
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe(base);
		if (collision) {
			expect(project.targets).toHaveLength(0);
			expect(project.defaults).toBeUndefined();
			expect(
				report.rows.filter((row: { reason?: string }) =>
					row.reason?.includes("profiles collide"),
				),
			).toHaveLength(2);
			expect(
				report.defaultDecisions.find(
					(entry: { action: string }) => entry.action === "run",
				)?.status,
			).toBe("blocked");
			return;
		}
		expect(project.targets[0].id).toBe("run-compose-qa-ivy");
		expect(project.targets[0].profile).toBe("QA-Ivy");
		expect(project.defaults.run).toBe("run-compose-qa-ivy");
		const host = serve(app);
		try {
			const url = new URL(host.url),
				token = new URLSearchParams(url.hash.slice(1)).get("token"),
				post = async (route: string, body: unknown) => {
					const response = await fetch(new URL(route, url), {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});
					expect(response.status).toBe(200);
					return response.json();
				};
			const draft = await post("/api/environments/drafts", {
					requestId: "profile-create",
					content,
				}),
				checked = await post("/api/environments/drafts/preflight", {
					requestId: "profile-check",
					id: draft.id,
					revision: draft.revision,
					digest: draft.digest,
					validateStagedCandidate: true,
				});
			const schema = await post("/api/environments/drafts/preflight", {
				requestId: "profile-schema",
				id: draft.id,
				revision: draft.revision,
				digest: draft.digest,
			});
			expect(schema.schemaAccepted).toBe(true);
			expect(checked.accepted).toBe(true);
			expect(checked.publicationAllowed).toBe(false);
			const snapshot = await app.snapshot();
			expect(snapshot.tasks).toHaveLength(0);
			expect(snapshot.reviews).toHaveLength(0);
			expect(snapshot.environments.runs).toHaveLength(0);
		} finally {
			host.stop();
		}
	});
