import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { readEngineFile } from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	configureTopologyFixture,
	topologyDefinitions as definitions,
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
const lifetime = "operator-infrastructure-v1" as const;
function gateway(app: Runtime) {
	const host = serve(app),
		token =
			new URLSearchParams(new URL(host.url).hash.slice(1)).get("token") ?? "";
	return {
		host,
		post: (route: string, body: unknown, authenticated = true) =>
			fetch(new URL(route, host.url), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(authenticated ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			}),
	};
}
async function observed(
	app: Runtime,
	check: (state: Awaited<ReturnType<Runtime["snapshot"]>>) => boolean,
) {
	const end = Date.now() + 15000;
	while (Date.now() < end) {
		const state = await app.snapshot();
		if (check(state)) return state;
		await Bun.sleep(20);
	}
	throw new Error("Native operator state did not settle");
}
for (const provider of ["docker", "podman"] as const)
	test(`authenticated ${provider} operator controls six explicit infrastructure units independently with one topology, no keeper or model`, async () => {
		const { app, config } = await fixture(false, (config) => {
			config.profiles = [];
			engines.push(configureTopologyFixture(config, provider));
		});
		const { host, post } = gateway(app),
			client = new ClientConnection(host.client);
		try {
			const request = {
				apps: services,
				action: "run",
				target: "run",
				lifetime,
				requestId: `operator-${provider}`,
			};
			expect(
				(await post("/api/environments/actions", request, false)).status,
			).toBe(401);
			const started = await post("/api/environments/actions", request);
			expect(started.status).toBe(200);
			const { taskId } = (await started.json()) as { taskId: number };
			expect(
				await (await post("/api/environments/actions", request)).json(),
			).toEqual({ taskId });
			expect(
				(
					await post("/api/environments/actions", {
						...request,
						apps: ["redis"],
					})
				).status,
			).toBe(400);
			const review = await pendingReview(app, taskId);
			expect(review.snapshot).toContain(lifetime);
			expect(review.snapshot).toContain('"operatorRoot": true');
			expect(review.snapshot).toContain("no model or agent is invoked");
			expect(readEngineFile(file(config)).history).toHaveLength(0);
			await approve(app, taskId);
			const live = await observed(
				app,
				(state) =>
					state.environments.runs.length === 7 &&
					state.environments.runs.every(
						(run) => run.state === "running" && run.ready === true,
					),
			);
			expect(
				live.environments.runs.every(
					(run) => run.plan.projectKind === "infrastructure",
				),
			).toBe(true);
			expect(
				live.environments.runs.filter((run) => run.plan.operatorRoot),
			).toHaveLength(6);
			expect(live.messages).toHaveLength(0);
			expect(live.tasks.find((task) => task.id === taskId)?.kind).toBe(
				"operator-environment",
			);
			const protectedUnit = await app.environments.snapshot("redis");
			expect(protectedUnit.runs[0]?.idle.protection).toBe("operator-owner");
			expect(protectedUnit.runs[0]?.idle.ttlMs).toBeNull();
			await app.tick(Date.now() + 60 * 60_000);
			expect(
				(await app.snapshot()).environments.runs.every(
					(run) => run.state === "running",
				),
			).toBe(true);
			const state = readEngineFile(file(config));
			expect(Object.keys(state.containers)).toHaveLength(6);
			expect(Object.keys(state.networks ?? {})).toHaveLength(1);
			const current = await app.snapshot();
			const root = current.environments.runs.find(
					(run) => run.plan.app === "redis",
				),
				topology = current.environments.runs.find(
					(run) => run.plan.app === "topology",
				);
			if (!root || !topology) throw new Error("Missing native unit/topology");
			const body = {
				requestId: "redis-unit-stop",
				runId: root.id,
				revision: root.revision,
				reason: "Stop this original infrastructure unit only",
			};
			expect(
				(await post("/api/environments/units/stop", body, false)).status,
			).toBe(401);
			for (const rejected of [
				{ ...body, revision: root.revision + 1 },
				{ ...body, revision: 1.5 },
				{ ...body, runId: topology.id, revision: topology.revision },
				{ ...body, adopt: true },
			])
				expect(
					(await post("/api/environments/units/stop", rejected)).status,
				).toBe(400);
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				6,
			);
			const stopped = await post("/api/environments/units/stop", body);
			expect(stopped.status).toBe(200);
			const receipt = await stopped.json();
			expect(
				await (await post("/api/environments/units/stop", body)).json(),
			).toEqual(receipt);
			expect(
				(
					await post("/api/environments/units/stop", {
						...body,
						reason: "Different intention",
					})
				).status,
			).toBe(400);
			const remaining = await observed(
				app,
				(s) =>
					s.environments.runs.filter((run) => run.state === "running")
						.length === 6,
			);
			expect(
				remaining.environments.runs.find((run) => run.plan.app === "redis")
					?.state,
			).toBe("exited");
			expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
				5,
			);
			expect(
				Object.keys(readEngineFile(file(config)).networks ?? {}),
			).toHaveLength(1);
			client.connect();
			await eventually(
				async () => client.status,
				(status) => status === "connected",
			);
			const beforeStale = readEngineFile(file(config)).history.length;
			const stale = await client.call("environment.preview", {
				operation: "stop-unit",
				body: { ...body, requestId: "stale-reviewed-unit" },
			});
			await expect(
				client.call("environment.apply", {
					id: stale.id,
					approval: `approve:${stale.digest}`,
				}),
			).rejects.toThrow();
			expect(readEngineFile(file(config)).history).toHaveLength(beforeStale);
			for (const service of services.slice(1)) {
				const row = (await app.snapshot()).environments.runs.find(
					(run) => run.plan.app === service,
				);
				if (!row) throw new Error("Missing original unit");
				const candidate = await client.call("environment.preview", {
					operation: "stop-unit",
					body: {
						requestId: `stop-${service}`,
						runId: row.id,
						revision: row.revision,
						reason: "Settle this exact selected infrastructure unit",
					},
				});
				await expect(
					client.call("environment.apply", {
						id: candidate.id,
						approval: `approve:${"0".repeat(64)}`,
					}),
				).rejects.toThrow();
				await client.call("environment.apply", {
					id: candidate.id,
					approval: `approve:${candidate.digest}`,
				});
				await expect(
					client.call("environment.apply", {
						id: candidate.id,
						approval: `approve:${candidate.digest}`,
					}),
				).rejects.toThrow();
			}
			await app.harness.waitForTask(taskId as TaskId, context);
			const ended = await observed(app, (s) =>
				s.environments.runs.every((run) => run.state === "exited"),
			);
			expect(ended.messages).toHaveLength(0);
			const final = readEngineFile(file(config));
			expect(Object.keys(final.containers)).toHaveLength(0);
			expect(Object.keys(final.networks ?? {})).toHaveLength(0);
			expect(
				final.history.filter(
					(item) => item[2] === "network" && item[3] === "create",
				),
			).toHaveLength(1);
			expect(
				final.history.filter(
					(item) => item[2] === "network" && item[3] === "rm",
				),
			).toHaveLength(1);
			expect(
				final.history.findLastIndex((item) => item[2] === "rm"),
			).toBeLessThan(
				final.history.findIndex(
					(item) => item[2] === "network" && item[3] === "rm",
				),
			);
		} finally {
			client.close();
			await host.stop();
		}
	}, 90000);
for (const [name, request] of [
	["app roots", { apps: ["alpha"] }],
	["topology root", { apps: ["topology"] }],
	["selected topology", { apps: ["redis", "topology"] }],
	["agent lifetime substituted", { lifetime: "referenced-roots-v1" }],
	["derived root marker", { operatorRoot: true }],
	["unsupported action", { action: "build" }],
	["unrelated replicas", { replicas: 2 }],
] as const)
	test(`authenticated operator infrastructure refuses ${name} before any task or engine effect`, async () => {
		const { app, config } = await fixture(false, (config) =>
			engines.push(configureTopologyFixture(config)),
		);
		const { host, post } = gateway(app);
		try {
			const result = await post("/api/environments/actions", {
				apps: ["redis"],
				action: "run",
				target: "run",
				lifetime,
				requestId: "invalid-units",
				...request,
			});
			expect(result.status).toBe(400);
			const state = await app.snapshot();
			expect(state.tasks).toHaveLength(0);
			expect(state.reviews).toHaveLength(0);
			expect(state.environments.runs).toHaveLength(0);
			expect(readEngineFile(file(config)).history).toHaveLength(0);
		} finally {
			await host.stop();
		}
	});
test("operator infrastructure does not infer a service dependency as another independently selected unit", async () => {
	const { app, config } = await fixture(false, (config) => {
		engines.push(configureTopologyFixture(config));
		const content = JSON.parse(fs.readFileSync(definitions(config), "utf8"));
		const redis = content.projects.find(
			(project: { id: string }) => project.id === "redis",
		);
		if (!redis) throw new Error("Missing fixture unit");
		redis.targets[0].prerequisites.push({ app: "postgres", target: "run" });
		fs.writeFileSync(definitions(config), JSON.stringify(content));
	});
	const { host, post } = gateway(app);
	try {
		expect(
			(
				await post("/api/environments/actions", {
					apps: ["redis", "postgres"],
					action: "run",
					target: "run",
					lifetime,
					requestId: "dependent-units",
				})
			).status,
		).toBe(400);
		expect((await app.snapshot()).tasks).toHaveLength(0);
		expect(readEngineFile(file(config)).history).toHaveLength(0);
	} finally {
		await host.stop();
	}
});
test("rejected protected operator infrastructure review has no engine effects", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const response = await post("/api/environments/actions", {
			apps: services,
			action: "run",
			target: "run",
			lifetime,
			requestId: "reject-units",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		const review = await pendingReview(app, taskId);
		await app.decide(
			review.id,
			review.revision,
			"rejected",
			"Reject the synthetic unit acquisition",
		);
		await app.harness.waitForTask(taskId as TaskId, context);
		expect(readEngineFile(file(config)).history).toHaveLength(0);
		expect((await app.snapshot()).environments.runs).toHaveLength(0);
	} finally {
		await host.stop();
	}
});
test("protected operator cancellation settles all original infrastructure units before their topology", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const response = await post("/api/environments/actions", {
			apps: services,
			action: "run",
			target: "run",
			lifetime,
			requestId: "cancel-units",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		await pendingReview(app, taskId);
		await approve(app, taskId);
		await observed(
			app,
			(state) =>
				state.environments.runs.length === 7 &&
				state.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		expect((await post(`/api/tasks/${taskId}/cancel`, {})).status).toBe(200);
		await app.harness.waitForTask(taskId as TaskId, context);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			0,
		);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(0);
		expect(
			readEngineFile(file(config)).history.filter(
				(item) => item[2] === "network" && item[3] === "rm",
			),
		).toHaveLength(1);
	} finally {
		await host.stop();
	}
}, 60000);

test("agent tool input cannot select protected operator infrastructure lifetime", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_start", { apps: ["redis"], lifetime }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("request_review", {
				path: ".",
				title: "Protected scope refused",
			}),
			{ stopReason: "toolUse" },
		),
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Protected scope refused");
	expect(readEngineFile(file(config)).history).toHaveLength(0);
	expect((await app.snapshot()).environments.runs).toHaveLength(0);
	expect(
		(await app.snapshot()).reviews.filter((review) =>
			review.title.startsWith("Environment "),
		),
	).toHaveLength(0);
});
test("unit control cannot upgrade an ordinary coupled operator review", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const response = await post("/api/environments/actions", {
			apps: ["redis"],
			action: "run",
			target: "run",
			requestId: "ordinary-operator",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		await pendingReview(app, taskId);
		await approve(app, taskId);
		const live = await observed(
			app,
			(state) =>
				state.environments.runs.length === 2 &&
				state.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		const unit = live.environments.runs.find((run) => run.plan.app === "redis");
		if (!unit) throw new Error("Missing ordinary run");
		const before = readEngineFile(file(config)).history.length;
		expect(
			(
				await post("/api/environments/units/stop", {
					requestId: "no-upgrade",
					runId: unit.id,
					revision: unit.revision,
					reason: "Cannot upgrade an old approval",
				})
			).status,
		).toBe(400);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			1,
		);
		await app.cancel(taskId);
		await app.harness.waitForTask(taskId as TaskId, context);
	} finally {
		await host.stop();
	}
}, 30000);
test("reopened operator observations and copied labels cannot restore unit authority", async () => {
	const { app, config, open } = await fixture(true, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const first = gateway(app);
	let second: ReturnType<typeof gateway> | undefined;
	try {
		const response = await first.post("/api/environments/actions", {
			apps: ["redis"],
			action: "run",
			target: "run",
			lifetime,
			requestId: "original-unit",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		await pendingReview(app, taskId);
		await approve(app, taskId);
		const live = await observed(
			app,
			(state) =>
				state.environments.runs.length === 2 &&
				state.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		const unit = live.environments.runs.find((run) => run.plan.app === "redis");
		if (!unit) throw new Error("Missing original run");
		const original = readEngineFile(file(config));
		await first.host.stop();
		await app.close();
		const settled = readEngineFile(file(config));
		settled.containers = original.containers;
		settled.networks = original.networks;
		fs.writeFileSync(file(config), JSON.stringify(settled));
		const reopened = await open();
		second = gateway(reopened);
		const before = readEngineFile(file(config)).history.length;
		expect(
			(
				await second.post("/api/environments/units/stop", {
					requestId: "no-restored-handle",
					runId: unit.id,
					revision: unit.revision,
					reason: "An observation is not an original live capability",
				})
			).status,
		).toBe(400);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			1,
		);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
	} finally {
		await first.host.stop();
		await second?.host.stop();
	}
}, 30000);
test("unit stop cannot partially release an operator batch whose startup is still in flight", async () => {
	const { app, config } = await fixture(false, (config) => {
		engines.push(configureTopologyFixture(config));
		const state = readEngineFile(file(config));
		state.startDelayMs = 1500;
		fs.writeFileSync(file(config), JSON.stringify(state));
	});
	const { host, post } = gateway(app);
	try {
		const response = await post("/api/environments/actions", {
			apps: ["redis", "postgres"],
			action: "run",
			target: "run",
			lifetime,
			requestId: "starting-units",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		await pendingReview(app, taskId);
		await approve(app, taskId);
		const partial = await observed(
			app,
			(state) =>
				state.environments.runs.some(
					(run) =>
						run.plan.app === "redis" &&
						run.state === "running" &&
						run.ready === true,
				) &&
				state.environments.runs.some(
					(run) => run.plan.app === "postgres" && run.ready !== true,
				),
		);
		const unit = partial.environments.runs.find(
			(run) => run.plan.app === "redis",
		);
		if (!unit) throw new Error("Missing starting unit");
		const request = {
			requestId: "stop-after-startup",
			runId: unit.id,
			revision: unit.revision,
			reason: "No partial startup release",
		};
		expect((await post("/api/environments/units/stop", request)).status).toBe(
			400,
		);
		expect(
			readEngineFile(file(config)).history.filter((args) =>
				["stop", "rm"].includes(args[2] ?? ""),
			),
		).toHaveLength(0);
		await observed(
			app,
			(state) =>
				state.environments.runs.length === 3 &&
				state.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		expect((await post("/api/environments/units/stop", request)).status).toBe(
			200,
		);
		expect(Object.keys(readEngineFile(file(config)).containers)).toHaveLength(
			1,
		);
		await app.cancel(taskId);
		await app.harness.waitForTask(taskId as TaskId, context);
	} finally {
		await host.stop();
	}
}, 45000);

test("uncertain unit cleanup retains the topology and cannot be replayed as saved-resource authority", async () => {
	const { app, config } = await fixture(false, (config) =>
		engines.push(configureTopologyFixture(config)),
	);
	const { host, post } = gateway(app);
	try {
		const response = await post("/api/environments/actions", {
			apps: ["redis", "postgres"],
			action: "run",
			target: "run",
			lifetime,
			requestId: "uncertain-units",
		});
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		await pendingReview(app, taskId);
		await approve(app, taskId);
		const live = await observed(
			app,
			(state) =>
				state.environments.runs.length === 3 &&
				state.environments.runs.every(
					(run) => run.state === "running" && run.ready === true,
				),
		);
		const unit = live.environments.runs.find((run) => run.plan.app === "redis");
		if (!unit) throw new Error("Missing original unit");
		const offline = readEngineFile(file(config));
		offline.offline = true;
		fs.writeFileSync(file(config), JSON.stringify(offline));
		const request = {
			requestId: "uncertain-unit-stop",
			runId: unit.id,
			revision: unit.revision,
			reason: "Uncertain cleanup must retain its references",
		};
		expect((await post("/api/environments/units/stop", request)).status).toBe(
			400,
		);
		const retained = await app.snapshot();
		expect(
			retained.environments.runs.find((run) => run.plan.app === "redis")?.state,
		).toBe("interrupted");
		expect(
			retained.environments.runs.find((run) => run.plan.app === "postgres")
				?.state,
		).toBe("running");
		const reachable = readEngineFile(file(config));
		reachable.offline = false;
		fs.writeFileSync(file(config), JSON.stringify(reachable));
		const before = reachable.history.length;
		expect((await post("/api/environments/units/stop", request)).status).toBe(
			400,
		);
		expect(
			(
				await post("/api/environments/units/stop", {
					...request,
					requestId: "no-saved-unit-retry",
					revision: retained.environments.runs.find(
						(run) => run.plan.app === "redis",
					)?.revision,
				})
			).status,
		).toBe(400);
		expect(readEngineFile(file(config)).history).toHaveLength(before);
		expect(
			Object.keys(readEngineFile(file(config)).networks ?? {}),
		).toHaveLength(1);
		expect(
			readEngineFile(file(config)).history.filter(
				(args) => args[2] === "network" && args[3] === "rm",
			),
		).toHaveLength(0);
		await app.cancel(taskId);
		await app.harness.waitForTask(taskId as TaskId, context);
	} finally {
		await host.stop();
	}
}, 30000);
