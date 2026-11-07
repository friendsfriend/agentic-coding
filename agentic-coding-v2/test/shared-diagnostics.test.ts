import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { disposablePort, installPostgres } from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("attached shared roots query their reused database without fallback or second copy", async () => {
	const dbPort = disposablePort();
	const { app, fake, invocation } = await fixture(false, (config) => {
		installPostgres(config, dbPort);
		const file = path.join(config.configDir, "environments.json");
		const definition = JSON.parse(fs.readFileSync(file, "utf8"));
		const api = definition.projects.find(
			(project: { id: string }) => project.id === "api",
		);
		if (!api) throw new Error("Missing disposable SQL app");
		definition.projects.push({
			...api,
			id: "worker",
			requires: ["store"],
		});
		fs.writeFileSync(file, JSON.stringify(definition));
	});
	fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				async () =>
					(await app.environments.snapshot()).runs
						.filter((run) => run.state === "running")
						.map((run) => run.plan.app)
						.sort(),
				(apps) => apps.length === 2 && apps.includes("api"),
			);
			return call("env_start", {
				apps: ["worker"],
				lifetime: "shared-prerequisites-v1",
			});
		},
		async () => {
			await eventually(
				async () =>
					(await app.environments.snapshot()).runs
						.filter((run) => run.state === "running")
						.map((run) => run.plan.app)
						.sort(),
				(apps) => apps.length === 3,
			);
			return call("db_query", {
				infra: "store",
				app: "worker",
				sql: "SELECT count(*) AS count FROM items /* NATIVE_SQL_PROBE */",
			});
		},
		() =>
			call("request_review", {
				path: ".",
				title: "Shared SQL completed",
			}),
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	await approve(app, owner, "Environment run: worker");
	await eventually(
		async () =>
			(await app.environments.snapshot()).runs
				.filter((run) => run.state === "running")
				.map((run) => run.plan.app)
				.sort(),
		(apps) => apps.length === 3,
	);
	const attached = await app.environments.snapshot();
	const stores = attached.runs.filter((run) => run.plan.app === "store");
	expect(stores).toHaveLength(1);
	expect(stores[0]?.state).toBe("running");
	const worker = attached.runs.find((run) => run.plan.app === "worker");
	if (!worker) throw new Error("Missing attached shared root");
	const review = await pendingReview(app, owner, "Query store");
	const approved = JSON.parse(review.snapshot).request;
	expect(approved.input.app).toBe("worker");
	expect(approved.app).toBe("worker");
	expect(approved.root.run).toBe(worker.id);
	expect(approved.root.resources).toEqual([stores[0]?.id]);
	expect(review.snapshot).not.toContain("disposable-sql-secret");
	await approve(app, owner, "Query store");
	await pendingReview(app, owner, "Shared SQL completed");
	await approve(app, owner, "Shared SQL completed");
}, 60000);
