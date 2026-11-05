import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("approved coupled shell graphs record unique generation-bound application requirements without enabling reference control; reuse and reads cannot rewrite them", async () => {
	const { app, fake, config, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{ id: "base", kind: "infrastructure" },
					{ id: "cache", kind: "infrastructure", requires: ["base"] },
					{ id: "api", kind: "app", requires: ["cache", "base"] },
					{ id: "editor", kind: "app", requires: ["cache"] },
				].map((project) => ({
					...project,
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							readyText: "READY",
							command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').appendFileSync(process.env.STARTS,'start\\n');console.log('READY');setInterval(()=>{},1000)")}`,
							environment: {
								STARTS: path.join(config.configDir, `${project.id}-starts`),
							},
						},
					],
				})),
			}),
		);
	});
	let status = "",
		refused = false;
	fake.setResponses([
		call("env_start", { apps: ["api", "editor"] }),
		call("env_status", { app: "cache" }),
		(messages) => {
			status = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_status",
				),
			);
			return call("request_review", { path: ".", title: "Inspect graph" });
		},
		call("env_start", { apps: ["api", "editor"] }),
		call("request_review", { path: ".", title: "Reused graph" }),
		call("env_start", {
			apps: ["api", "editor"],
			lifetime: "referenced-roots-v1",
		}),
		call("request_review", {
			path: ".",
			title: "Referenced mode refused while a coupled batch is held",
		}),
		call("env_stop", { apps: ["api"] }),
		(messages) => {
			refused = messages.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.toolName === "env_start" &&
					message.isError,
			);
			return call("request_review", {
				path: ".",
				title: "Coupled cleanup complete",
			});
		},
		fauxAssistantMessage("No reference execution was enabled"),
	]);
	const owner = await app.startTask(invocation);
	await pendingReview(app, owner);
	expect((await app.environments.snapshot()).referenceGraphs).toEqual([]);
	await approve(app, owner);
	await pendingReview(app, owner, "Inspect graph");
	const before = await app.environments.snapshot(),
		graph = before.referenceGraphs[0];
	if (!graph) throw new Error("Missing observed graph");
	expect(status).toContain("coupled-observation-only");
	expect(graph).toMatchObject({
		protocol: "native-root-reference-graph-v1",
		control: "coupled-observation-only",
		owner,
		observation: "running-observed",
	});
	expect(JSON.stringify(graph)).not.toContain("planDigest");
	expect(JSON.stringify(graph)).not.toContain("STARTS");
	expect(graph.roots).toHaveLength(2);
	expect(graph.members).toHaveLength(4);
	expect(
		graph.roots.every(
			(root) =>
				root.resources.length === 2 && new Set(root.resources).size === 2,
		),
	).toBe(true);
	expect(
		graph.resources.every(
			(resource) =>
				resource.applicationRequirements === 2 &&
				resource.unsettledRequirements === 2,
		),
	).toBe(true);
	expect(new Set(graph.members.map((member) => member.run))).toEqual(
		new Set(before.runs.map((run) => run.id)),
	);
	expect((await app.environments.snapshot("cache")).referenceGraphs).toEqual([
		graph,
	]);
	await approve(app, owner, "Inspect graph");
	await approve(app, owner);
	await pendingReview(app, owner, "Reused graph");
	expect((await app.environments.snapshot()).referenceGraphs).toEqual([graph]);
	await approve(app, owner, "Reused graph");
	// A scoped request cannot upgrade or split this held coupled batch.
	await approve(app, owner);
	await approve(
		app,
		owner,
		"Referenced mode refused while a coupled batch is held",
	);
	await pendingReview(app, owner, "Coupled cleanup complete");
	const stopped = await app.environments.snapshot(),
		settled = stopped.referenceGraphs[0];
	expect(refused).toBe(true);
	expect(stopped.runs).toHaveLength(4);
	expect(stopped.runs.every((run) => run.state === "exited")).toBe(true); // Default coupling remains intact, including editor.
	expect(settled?.observation).toBe("settled-observed");
	expect(
		settled?.roots.every((root) => root.observation === "settled-observed"),
	).toBe(true);
	expect(
		settled?.resources.every(
			(resource) =>
				resource.applicationRequirements === 2 &&
				resource.unsettledRequirements === 0,
		),
	).toBe(true);
	for (const member of graph.members)
		expect(
			fs.readFileSync(
				path.join(config.configDir, `${member.app}-starts`),
				"utf8",
			),
		).toBe("start\n");
	await approve(app, owner, "Coupled cleanup complete");
	await app.harness.waitForTask(owner as TaskId, context);
}, 15000);
