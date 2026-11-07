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

test("restarted shared roots are never adopted; fresh acquisition starts a new generation", async () => {
	const dbPort = disposablePort();
	const { app, fake, invocation, open } = await fixture(true, (config) => {
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
			return call("request_review", {
				path: ".",
				title: "Shared attached",
			});
		},
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	await approve(app, owner, "Environment run: worker");
	await pendingReview(app, owner, "Shared attached");
	const before = await app.environments.snapshot();
	const stores = before.runs.filter((run) => run.plan.app === "store");
	expect(stores).toHaveLength(1);
	expect(stores[0]?.state).toBe("running");
	const storeId = stores[0]?.id;
	await app.close();
	const reopened = await open();
	const after = await reopened.environments.snapshot();
	expect(after.runs.filter((run) => run.state === "running")).toHaveLength(0);
	expect(after.runs.map((run) => run.id).sort()).toEqual(
		before.runs.map((run) => run.id).sort(),
	);
	for (const run of after.runs)
		expect(["exited", "interrupted"]).toContain(run.state);
	const stale = after.runs.find((run) => run.plan.app === "worker");
	if (!stale) throw new Error("Missing interrupted worker root");
	// No live generation remains, so attachment reconciliation has nothing to
	// adopt: the interrupted store generation is quarantine history, not a
	// reusable handle. A fresh acquisition must start a new generation.
	fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async () => {
			await eventually(
				async () =>
					(await reopened.environments.snapshot()).runs
						.filter((run) => run.state === "running")
						.map((run) => run.plan.app)
						.sort(),
				(apps) => apps.length === 2,
			);
			return call("request_review", {
				path: ".",
				title: "Shared restarted",
			});
		},
	]);
	const fresh = await reopened.startTask({
		...invocation,
		requestId: "task-2",
	});
	await approve(reopened, fresh);
	await pendingReview(reopened, fresh, "Shared restarted");
	const restarted = await reopened.environments.snapshot();
	const live = restarted.runs.filter((run) => run.state === "running");
	expect(live.map((run) => run.plan.app).sort()).toEqual(["api", "store"]);
	expect(live.map((run) => run.id)).not.toContain(storeId);
	expect(["exited", "interrupted"]).toContain(
		restarted.runs.find((run) => run.id === storeId)?.state ?? "missing",
	);
	await approve(reopened, fresh, "Shared restarted");
}, 60000);
