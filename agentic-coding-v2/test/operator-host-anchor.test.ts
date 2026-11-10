import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { readEngineFile } from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	configureTopologyFixture,
	topologyEngineFile as file,
	infrastructureServices as services,
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
const lifetime = "operator-infrastructure-v3" as const;

test("another native owner still queues rather than borrowing an empty protected host anchor", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const owner = await start(app, post, ["redis"]);
		await stop(app, post, "redis");
		const before = readEngineFile(file(config)).history.length;
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_start", { apps: ["beta"], timeoutSec: 1 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("request_review", {
					path: ".",
					title: "No host borrowing",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const borrower = await app.startTask(invocation);
		await approve(app, borrower);
		await pendingReview(app, borrower, "No host borrowing");
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			0,
		);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
		await app.cancel(borrower);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	} finally {
		await host.stop();
	}
}, 30000);
test("v3 still refuses uncertain cleanup rather than treating an interrupted generation as a restartable failure", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const owner = await start(app, post, ["redis"]);
		const live = (await app.snapshot()).environments.runs.find(
			(run) => run.plan.app === "redis",
		);
		if (!live) throw new Error("Missing host unit");
		const state = readEngineFile(file(config));
		state.offline = true;
		fs.writeFileSync(file(config), JSON.stringify(state));
		expect(
			(
				await post("/api/environments/units/stop", {
					requestId: "uncertain-host-stop",
					runId: live.id,
					revision: live.revision,
					reason: "Retain uncertain original resources",
				})
			).status,
		).toBe(400);
		const interrupted = (await app.snapshot()).environments.runs.find(
			(run) => run.id === live.id,
		);
		expect(interrupted?.state).toBe("interrupted");
		const restored = readEngineFile(file(config));
		restored.offline = false;
		fs.writeFileSync(file(config), JSON.stringify(restored));
		expect(
			(
				await post("/api/environments/units/readd", {
					requestId: "no-uncertain-host-retry",
					runId: live.id,
					revision: interrupted?.revision,
					reason: "Must never adopt unknown resources",
				})
			).status,
		).toBe(400);
		expect(await app.environments.unitStarts.history()).toHaveLength(0);
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
		post: (route: string, body: unknown) =>
			fetch(new URL(route, host.url), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(body),
			}),
	};
}
async function observed(
	app: Runtime,
	check: (snapshot: Awaited<ReturnType<Runtime["snapshot"]>>) => boolean,
) {
	const end = Date.now() + 15000;
	while (Date.now() < end) {
		const snapshot = await app.snapshot();
		if (check(snapshot)) return snapshot;
		await Bun.sleep(20);
	}
	throw new Error("Native host anchor did not settle");
}
async function start(
	app: Runtime,
	post: ReturnType<typeof gateway>["post"],
	apps = services,
) {
	const response = await post("/api/environments/actions", {
		apps,
		action: "run",
		target: "run",
		lifetime,
		requestId: "native-host-anchor",
	});
	expect(response.status).toBe(200);
	const { taskId } = (await response.json()) as { taskId: number };
	const review = await pendingReview(app, taskId);
	expect(review.snapshot).toContain('"operatorAnchor": true');
	expect(review.snapshot).toContain("operatorAnchorScope");
	await approve(app, taskId);
	await observed(
		app,
		(s) =>
			s.environments.runs.length === apps.length + 1 &&
			s.environments.runs.every(
				(run) => run.state === "running" && run.ready === true,
			),
	);
	return taskId;
}
async function stop(
	app: Runtime,
	post: ReturnType<typeof gateway>["post"],
	service: string,
) {
	const run = (await app.snapshot()).environments.runs
		.filter((run) => run.plan.app === service && run.state === "running")
		.at(-1);
	if (!run) throw new Error("Missing selected host unit");
	const response = await post("/api/environments/units/stop", {
		requestId: `stop-${run.id}`,
		runId: run.id,
		revision: run.revision,
		reason: "Stop this original host unit only",
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const exited = (await app.snapshot()).environments.runs.find(
		(row) => row.id === run.id,
	);
	if (!exited) throw new Error("Missing released host unit");
	return exited;
}
async function request(
	app: Runtime,
	post: ReturnType<typeof gateway>["post"],
	owner: number,
	unit: { id: string; revision: number },
	requestId: string,
) {
	const response = await post("/api/environments/units/readd", {
		requestId,
		runId: unit.id,
		revision: unit.revision,
		reason: "Fresh reviewed original-anchor service generation",
	});
	expect(response.status, await response.clone().text()).toBe(200);
	await pendingReview(app, owner, "Environment re-add: redis");
	return response.json() as Promise<{ id: string }>;
}
for (const provider of ["docker", "podman"] as const)
	test(`native ${provider} host anchor survives all six stopped units without a keeper and re-adds on the same original bridge`, async () => {
		const { app, config } = await fixture(false, (config) => {
			config.profiles = [];
			engines.push(configureTopologyFixture(config, provider));
		});
		const { host, post } = gateway(app);
		try {
			const owner = await start(app, post),
				bridge = Object.values(readEngineFile(file(config)).networks ?? {})[0]
					?.Id;
			let redis: { id: string; revision: number } | undefined;
			for (const service of services) {
				const exited = await stop(app, post, service);
				if (service === "redis") redis = exited;
			}
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				0,
			);
			expect(
				Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
			).toBe(bridge);
			const held = (await app.snapshot()).environments.runs.filter(
				(run) => run.state === "running",
			);
			expect(held).toHaveLength(1);
			expect(held[0]?.plan.operatorAnchor).toBe(true);
			expect(held[0]?.plan.projectKind).toBe("infrastructure");
			expect(held[0]?.pid).toBeNull();
			expect((await app.taskResult(owner))?.state.status).not.toBe("terminal");
			await app.tick(Date.now() + 60 * 60_000);
			expect(
				(await app.environments.snapshot("topology")).runs[0]?.idle.protection,
			).toBe("operator-owner");
			if (!redis) throw new Error("Missing released Redis unit");
			const admitted = await request(
				app,
				post,
				owner,
				redis,
				"from-empty-anchor",
			);
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				0,
			);
			await approve(app, owner, "Environment re-add: redis");
			await observed(app, (s) =>
				s.environments.runs.some(
					(run) =>
						run.plan.app === "redis" &&
						run.id !== redis?.id &&
						run.state === "running" &&
						run.ready === true,
				),
			);
			await eventually(
				() => app.environments.unitStarts.history(),
				(rows) =>
					rows.some(
						(row) => row.id === admitted.id && row.state === "completed",
					),
			);
			expect(
				Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
			).toBe(bridge);
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				1,
			);
			await stop(app, post, "redis");
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				0,
			);
			expect(
				Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
			).toBe(bridge);
			expect(
				readEngineFile(file(config)).history.filter(
					(args) => args[2] === "network" && args[3] === "rm",
				),
			).toHaveLength(0);
			await app.cancel(owner);
			await app.harness.waitForTask(owner as TaskId, context);
			const final = readEngineFile(file(config));
			expect(Object.keys(final.networks ?? {})).toHaveLength(0);
			expect(
				final.history.filter(
					(args) => args[2] === "network" && args[3] === "create",
				),
			).toHaveLength(1);
			expect(
				final.history.filter(
					(args) => args[2] === "network" && args[3] === "rm",
				),
			).toHaveLength(1);
			expect((await app.snapshot()).messages).toHaveLength(0);
		} finally {
			await host.stop();
		}
	}, 60000);
test("v3 may review a confirmed cleaned failed generation, but never repeats its failed dispatch automatically", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const owner = await start(app, post, ["redis"]),
			unit = await stop(app, post, "redis"),
			bridge = Object.values(readEngineFile(file(config)).networks ?? {})[0]
				?.Id;
		const failedRequest = await request(
			app,
			post,
			owner,
			unit,
			"unhealthy-host-unit",
		);
		const state = readEngineFile(file(config));
		state.initialHealth = "unhealthy";
		fs.writeFileSync(file(config), JSON.stringify(state));
		await approve(app, owner, "Environment re-add: redis");
		await eventually(
			() => app.environments.unitStarts.history(),
			(rows) =>
				rows.some(
					(row) => row.id === failedRequest.id && row.state === "interrupted",
				),
		);
		const failed = (await app.snapshot()).environments.runs
			.filter((run) => run.plan.app === "redis")
			.at(-1);
		expect(failed?.state).toBe("exited");
		expect(Boolean(failed?.error) || failed?.exitCode !== 0).toBe(true);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			0,
		);
		expect(
			Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
		).toBe(bridge);
		const reachable = readEngineFile(file(config));
		delete reachable.initialHealth;
		fs.writeFileSync(file(config), JSON.stringify(reachable));
		if (!failed) throw new Error("Missing failed but cleaned generation");
		const fresh = await request(
			app,
			post,
			owner,
			failed,
			"fresh-after-cleaned-failure",
		);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			0,
		);
		await approve(app, owner, "Environment re-add: redis");
		await observed(app, (s) =>
			s.environments.runs.some(
				(run) =>
					run.plan.app === "redis" &&
					run.id !== failed.id &&
					run.state === "running" &&
					run.ready === true,
			),
		);
		await eventually(
			() => app.environments.unitStarts.history(),
			(rows) =>
				rows.some((row) => row.id === fresh.id && row.state === "completed"),
		);
		expect(
			Object.values(readEngineFile(file(config)).networks ?? {})[0]?.Id,
		).toBe(bridge);
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	} finally {
		await host.stop();
	}
}, 45000);
test("closed host anchor cannot be reconstructed by approving a saved pending service review", async () => {
	const { app, config, open } = await fixture(true, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const first = gateway(app);
	let second: ReturnType<typeof gateway> | undefined;
	try {
		const owner = await start(app, first.post, ["redis"]),
			unit = await stop(app, first.post, "redis");
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
		await request(app, first.post, owner, unit, "pending-host-reopen");
		const review = await pendingReview(app, owner, "Environment re-add: redis");
		await first.host.stop();
		await app.close();
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(0);
		const before = readEngineFile(file(config)).history.length;
		const reopened = await open();
		second = gateway(reopened);
		expect(
			(
				await second.post(`/api/reviews/${review.id}`, {
					revision: review.revision,
					decision: "approved",
					comments: "Test original-handle refusal only",
				})
			).status,
		).toBe(200);
		await reopened.harness.waitForTask(owner as TaskId, context);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect((await reopened.environments.unitStarts.history())[0]?.state).toBe(
			"interrupted",
		);
	} finally {
		await first.host.stop();
		await second?.host.stop();
	}
}, 30000);
test("host anchor scope still refuses selecting topology as a service or supplying private plan markers", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		for (const options of [
			{ apps: ["topology"] },
			{ apps: ["redis"], operatorAnchor: true },
			{ apps: ["alpha"] },
		])
			expect(
				(
					await post("/api/environments/actions", {
						action: "run",
						target: "run",
						lifetime,
						requestId: JSON.stringify(options),
						...options,
					})
				).status,
			).toBe(400);
		expect((await app.snapshot()).tasks).toHaveLength(0);
		expect(readEngineFile(file(config)).history).toHaveLength(0);
	} finally {
		await host.stop();
	}
});
