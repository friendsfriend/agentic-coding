// Explicit operator-approved namespace create/delete: each operation needs its
// own exact approval, runs only through the inspected kubeconfig reference,
// never adopts an existing namespace and never treats a miss as deleted. The
// fake client proves the fences and the shaped observations, not a live API.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { namespaceName } from "../src/environment/cluster.ts";
import { configureLocalCluster, namespaceClient } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const toolTexts = (transcript: string): string[] =>
	(
		JSON.parse(transcript) as {
			role: string;
			content?: { type: string; text?: string }[];
		}[]
	)
		.filter((message) => message.role === "toolResult")
		.flatMap((message) => message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "");
const call = (op: string, namespace: string) =>
	fauxAssistantMessage(
		fauxToolCall("env_cluster_namespace", {
			cluster: "local",
			op,
			namespace,
		}),
		{ stopReason: "toolUse" },
	);
test("namespaceName admits DNS labels and refuses reserved or malformed names", () => {
	expect(namespaceName("operators-1")).toBe("operators-1");
	for (const refused of [
		"kube-system",
		"kube-public",
		"kube-node-lease",
		"default",
		"Upper",
		"-leading",
		"trailing-",
		"has space",
		"a".repeat(64),
		"",
		42,
	])
		expect(() => namespaceName(refused)).toThrow(
			/reserved system set|Invalid cluster namespace/,
		);
});
for (const scenario of [
	"create-delete",
	"existing",
	"missing",
	"changed",
	"unavailable",
]) {
	test(`explicit cluster namespace operation: ${scenario}`, async () => {
		const operations =
			scenario === "create-delete"
				? [
						{ op: "create", namespace: "operators-1" },
						{ op: "delete", namespace: "operators-1" },
					]
				: scenario === "existing"
					? [
							{ op: "create", namespace: "taken" },
							{ op: "create", namespace: "taken" },
						]
					: [
							{
								op: scenario === "missing" ? "delete" : "create",
								namespace: "ghost",
							},
						];
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configureLocalCluster(config, namespaceClient, {
				FIXTURE_STATE: path.join(config.configDir, "namespaces.json"),
				FIXTURE_CALLS: path.join(config.configDir, "calls.txt"),
				FIXTURE_DOWN: scenario === "unavailable" ? "yes" : "no",
			}),
		);
		const transcripts: string[] = [];
		const [first] = operations;
		fake.setResponses([
			call(first.op, first.namespace),
			...operations.map(
				(_operation, index) => (messages: { messages: unknown }) => {
					transcripts.push(JSON.stringify(messages.messages));
					const next = operations[index + 1];
					return next
						? call(next.op, next.namespace)
						: fauxAssistantMessage("Operation finished");
				},
			),
		]);
		const calls = path.join(config.configDir, "calls.txt");
		const expectedCalls =
			scenario === "changed" ? [false] : operations.map(() => true);
		let seen = "";
		const task = await app.startTask(invocation);
		for (const [index, { op, namespace }] of operations.entries()) {
			const title = `Cluster namespace ${op}: ${namespace}`;
			await pendingReview(app, task, title);
			// No kubectl call for this operation may precede its own approval.
			expect(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").toBe(
				seen,
			);
			if (scenario === "changed")
				fs.appendFileSync(path.join(config.configDir, "local.json"), "\n");
			await approve(app, task, title);
			if (expectedCalls[index])
				seen = await eventually(
					async () =>
						fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "",
					(value) => value !== seen,
				);
		}
		await app.harness.waitForTask(task as TaskId, context);
		if (scenario === "create-delete") {
			expect(toolTexts(transcripts[0]).join("\n")).toContain(
				'"status":"created"',
			);
			expect(transcripts[0]).toContain("operators-1");
			expect(transcripts[0]).toContain("11111111-2222-3333-4444-");
			expect(transcripts[0]).not.toContain("private-api-output");
			expect(toolTexts(transcripts[1]).join("\n")).toContain(
				'"status":"deleted"',
			);
		} else if (scenario === "existing") {
			expect(toolTexts(transcripts[0]).join("\n")).toContain(
				'"status":"created"',
			);
			expect(transcripts[1]).toContain('"isError":true');
			expect(transcripts[1]).toContain("never adopted");
		} else if (scenario === "missing") {
			expect(transcripts[0]).toContain('"isError":true');
			expect(transcripts[0]).toContain("never treated as deleted");
		} else if (scenario === "unavailable") {
			expect(transcripts[0]).toContain("Kubernetes namespace creation failed");
			expect(fs.existsSync(path.join(config.configDir, "calls.txt"))).toBe(
				true,
			);
		} else {
			expect(transcripts[0]).not.toContain('"status":"created"');
			expect(fs.existsSync(path.join(config.configDir, "calls.txt"))).toBe(
				false,
			);
		}
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
		expect(
			fs
				.readdirSync(config.stateDir)
				.some((name) => name.startsWith("cluster-inspection-")),
		).toBe(false);
	}, 30000);
}
