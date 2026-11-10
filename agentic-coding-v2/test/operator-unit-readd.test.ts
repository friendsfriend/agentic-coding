import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { git } from "../src/git.ts";
import { record } from "../src/protocol/index.ts";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection, dataList } from "../src/tui/client/connection.ts";
import { readEngineFile } from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	configureTopologyFixture,
	topologyEngineFile as file,
} from "./fixtures/network-topology.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof configureTopologyFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((engine) => engine.stop(true)));
	}
});
const lifetime = "operator-infrastructure-v2" as const;

test("reopened pending re-add review cannot restore original topology authority", async () => {
	const { app, config, open } = await fixture(true, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const first = gateway(app);
	let second: ReturnType<typeof gateway> | undefined;
	try {
		const owner = await start(app, first.post),
			unit = await stop(app, first.post, "redis");
		expect(
			(
				await first.post("/api/environments/units/readd", {
					requestId: "reopen-readd",
					runId: unit.id,
					revision: unit.revision,
					reason: "Never restore execution from a saved review",
				})
			).status,
		).toBe(200);
		const review = await pendingReview(app, owner, "Environment re-add: redis");
		await first.host.stop();
		await app.close();
		const before = readEngineFile(file(config)).history.length;
		const reopened = await open();
		second = gateway(reopened);
		expect(
			(
				await second.post(`/api/reviews/${review.id}`, {
					revision: review.revision,
					decision: "approved",
					comments: "Approve only to test refusal after lost handles",
				})
			).status,
		).toBe(200);
		await reopened.harness.waitForTask(owner as TaskId, context);
		expect((await reopened.environments.unitStarts.history())[0]?.state).toBe(
			"interrupted",
		);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(0);
	} finally {
		await first.host.stop();
		await second?.host.stop();
	}
}, 30000);
test("changed original workspace HEAD refuses a previously reviewed re-add without affecting sibling units", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const owner = await start(app, post),
			unit = await stop(app, post, "redis");
		expect(
			(
				await post("/api/environments/units/readd", {
					requestId: "changed-head",
					runId: unit.id,
					revision: unit.revision,
					reason: "Pin the original workspace generation",
				})
			).status,
		).toBe(200);
		const review = await pendingReview(app, owner, "Environment re-add: redis");
		await git(config.repositories[0] ?? "", [
			"commit",
			"--allow-empty",
			"-m",
			"disposable re-add HEAD fence",
		]);
		const before = readEngineFile(file(config)).history.length;
		await app.decide(
			review.id,
			review.revision,
			"approved",
			"Test the exact original HEAD fence",
		);
		await eventually(
			() => app.environments.unitStarts.history(),
			(rows) => rows.some((row) => row.state === "interrupted"),
		);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			1,
		);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	} finally {
		await host.stop();
	}
}, 30000);

function gateway(app: Runtime) {
	const host = serve(app),
		token =
			new URLSearchParams(new URL(host.url).hash.slice(1)).get("token") ?? "";
	return {
		host,
		post: (route: string, body: unknown, auth = true) =>
			fetch(new URL(route, host.url), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(auth ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			}),
	};
}
async function observed(
	app: Runtime,
	check: (snapshot: Awaited<ReturnType<Runtime["snapshot"]>>) => boolean,
) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const snapshot = await app.snapshot();
		if (check(snapshot)) return snapshot;
		await Bun.sleep(20);
	}
	throw new Error("Native re-add state did not settle");
}
async function start(
	app: Runtime,
	post: ReturnType<typeof gateway>["post"],
	mode: typeof lifetime | "operator-infrastructure-v1" = lifetime,
) {
	const response = await post("/api/environments/actions", {
		apps: ["redis", "postgres"],
		action: "run",
		target: "run",
		lifetime: mode,
		requestId: "original-units",
	});
	expect(response.status).toBe(200);
	const { taskId } = (await response.json()) as { taskId: number };
	await pendingReview(app, taskId);
	await approve(app, taskId);
	await observed(
		app,
		(s) =>
			s.environments.runs.length === 3 &&
			s.environments.runs.every(
				(run) => run.state === "running" && run.ready === true,
			),
	);
	return taskId;
}
async function stop(
	app: Runtime,
	post: ReturnType<typeof gateway>["post"],
	appId: string,
) {
	const run = (await app.snapshot()).environments.runs
		.filter((run) => run.plan.app === appId && run.state === "running")
		.at(-1);
	if (!run) throw new Error("Missing original live unit");
	expect(
		(
			await post("/api/environments/units/stop", {
				requestId: `stop-${run.id}`,
				runId: run.id,
				revision: run.revision,
				reason: "Stop exact original unit",
			})
		).status,
	).toBe(200);
	const ended = (await app.snapshot()).environments.runs.find(
		(row) => row.id === run.id,
	);
	if (!ended) throw new Error("Missing confirmed released unit");
	return ended;
}
for (const provider of ["docker", "podman"] as const)
	test(`authenticated ${provider} re-add requires fresh native review, keeps the original topology and never reuses a unit generation`, async () => {
		const { app, config } = await fixture(false, (config) => {
			config.profiles = [];
			engines.push(configureTopologyFixture(config, provider));
		});
		const { host, post } = gateway(app),
			client = new ClientConnection(host.client);
		try {
			const owner = await start(app, post),
				topology = (await app.snapshot()).environments.runs.find(
					(run) => run.plan.compose?.networkOnly,
				);
			if (!topology) throw new Error("Missing topology");
			const network = Object.values(
				readEngineFile(file(config)).networks ?? {},
			)[0]?.Id;
			let previous = await stop(app, post, "redis");
			const oldest = previous;
			client.connect();
			await eventually(
				async () => client.status,
				(status) => status === "connected",
			);
			for (let generation = 0; generation < 2; generation++) {
				const request = {
					requestId: `re-add-${generation}`,
					runId: previous.id,
					revision: previous.revision,
					reason: "Explicit reviewed same-owner re-add",
				};
				expect(
					(await post("/api/environments/units/readd", request, false)).status,
				).toBe(401);
				expect(
					(
						await post("/api/environments/units/readd", {
							...request,
							revision: previous.revision + 1,
						})
					).status,
				).toBe(400);
				const candidate = await client.call("environment.preview", {
					operation: "readd-unit",
					body: request,
				});
				const admitted = record(
					await client.call("environment.apply", {
						id: candidate.id,
						approval: `approve:${candidate.digest}`,
					}),
				);
				expect(admitted.state).toBe("pending");
				const review = await pendingReview(
					app,
					owner,
					"Environment re-add: redis",
				);
				expect(review.snapshot).toContain(topology.id);
				expect(review.snapshot).toContain('"operatorTopology"');
				expect(
					Object.keys(readEngineFile(file(config)).containers),
				).toHaveLength(1);
				const duplicate = await (
					await post("/api/environments/units/readd", request)
				).json();
				expect(duplicate.id).toBe(admitted.id);
				expect(
					(
						await post("/api/environments/units/readd", {
							...request,
							requestId: "concurrent-unit",
						})
					).status,
				).toBe(400);
				expect(
					(
						await post(`/api/reviews/${review.id}`, {
							revision: review.revision,
							decision: "approved",
							comments: "Approve this exact synthetic re-add only",
						})
					).status,
				).toBe(200);
				const renewed = await observed(app, (s) =>
					s.environments.runs.some(
						(run) =>
							run.plan.app === "redis" &&
							run.id !== previous.id &&
							run.state === "running" &&
							run.ready === true,
					),
				);
				const unit = renewed.environments.runs.find(
					(run) => run.plan.app === "redis" && run.state === "running",
				);
				expect(unit?.owner).toBe(owner);
				expect(unit?.plan.operatorTopology).toBe(topology.id);
				expect(
					Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
				).toBe(network);
				expect(
					Object.keys(readEngineFile(file(config)).containers),
				).toHaveLength(2);
				expect(
					readEngineFile(file(config)).history.filter(
						(args) => args[2] === "network" && args[3] === "create",
					),
				).toHaveLength(1);
				const history = await client.call("environment.inspect", {
					operation: "unit-starts",
					selection: {},
				});
				expect(
					dataList(history).some(
						(row) =>
							record(row).id === admitted.id &&
							record(row).state === "completed",
					),
				).toBe(true);
				previous = await stop(app, post, "redis");
			}
			expect(
				(
					await post("/api/environments/units/readd", {
						requestId: "stale-old-generation",
						runId: oldest.id,
						revision: oldest.revision,
						reason: "Must select latest unit",
					})
				).status,
			).toBe(400);
			await stop(app, post, "postgres");
			await app.harness.waitForTask(owner as TaskId, context);
			expect(
				Object.keys(readEngineFile(file(config)).networks ?? {}),
			).toHaveLength(0);
			expect((await app.snapshot()).messages).toHaveLength(0);
		} finally {
			client.close();
			await host.stop();
		}
	}, 60000);
for (const scenario of ["v1", "live-unit", "extra-field"] as const)
	test(`native re-add refuses ${scenario} before queueing execution or another review`, async () => {
		const { app, config } = await fixture(false, (config) =>
			engines.push(configureTopologyFixture(config)),
		);
		const { host, post } = gateway(app);
		try {
			const owner = await start(
				app,
				post,
				scenario === "v1" ? "operator-infrastructure-v1" : lifetime,
			);
			const unit =
				scenario === "live-unit"
					? (await app.snapshot()).environments.runs.find(
							(run) => run.plan.app === "redis",
						)
					: await stop(app, post, "redis");
			if (!unit) throw new Error("Missing unit");
			const before = readEngineFile(file(config)).history.length;
			expect(
				(
					await post("/api/environments/units/readd", {
						requestId: "invalid-readd",
						runId: unit.id,
						revision: unit.revision,
						reason: "Refused scope",
						...(scenario === "extra-field" ? { adopt: true } : {}),
					})
				).status,
			).toBe(400);
			expect(await app.environments.unitStarts.history()).toHaveLength(0);
			expect(readEngineFile(file(config)).history).toHaveLength(before);
			await app.cancel(owner);
			await app.harness.waitForTask(owner as TaskId, context);
		} finally {
			await host.stop();
		}
	}, 30000);
for (const decision of ["rejected", "cancelled", "topology-closed"] as const)
	test(`pending unit re-add ${decision} never dispatches a replacement topology or unapproved unit`, async () => {
		const { app, config } = await fixture(false, (config) =>
			engines.push(configureTopologyFixture(config)),
		);
		const { host, post } = gateway(app);
		try {
			const owner = await start(app, post),
				unit = await stop(app, post, "redis");
			const response = await post("/api/environments/units/readd", {
				requestId: "reviewed-readd",
				runId: unit.id,
				revision: unit.revision,
				reason: "Exact native approval required",
			});
			expect(response.status).toBe(200);
			const review = await pendingReview(
				app,
				owner,
				"Environment re-add: redis",
			);
			const creates = readEngineFile(file(config)).history.filter(
				(args) => args[2] === "create",
			).length;
			if (decision === "cancelled") {
				await app.cancel(owner);
				await app.harness.waitForTask(owner as TaskId, context);
				expect(
					(
						await post(`/api/reviews/${review.id}`, {
							revision: review.revision,
							decision: "approved",
							comments: "Too late",
						})
					).status,
				).toBe(400);
			} else {
				if (decision === "topology-closed") await stop(app, post, "postgres");
				await app.decide(
					review.id,
					review.revision,
					decision === "rejected" ? "rejected" : "approved",
					"Synthetic native boundary decision",
				);
				await eventually(
					() => app.environments.unitStarts.history(),
					(rows) =>
						rows.some(
							(row) =>
								row.state ===
								(decision === "rejected" ? "rejected" : "interrupted"),
						),
				);
				if (decision === "rejected") {
					expect(
						Object.keys(readEngineFile(file(config)).containers),
					).toHaveLength(1);
					await app.cancel(owner);
				}
				await app.harness.waitForTask(owner as TaskId, context);
			}
			expect(
				readEngineFile(file(config)).history.filter(
					(args) => args[2] === "create",
				),
			).toHaveLength(creates);
			expect(
				readEngineFile(file(config)).history.filter(
					(args) => args[2] === "network" && args[3] === "create",
				),
			).toHaveLength(1);
		} finally {
			await host.stop();
		}
	}, 30000);
