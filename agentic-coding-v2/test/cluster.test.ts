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
test("explicit local cluster status waits for approval, keeps API data private and does not invent reachability or reuse changed configuration", async () => {
	for (const scenario of ["reachable", "unavailable", "changed"]) {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			const bin = path.join(config.configDir, "bin");
			fs.mkdirSync(bin);
			fs.writeFileSync(
				path.join(bin, "kubectl"),
				`#!${process.execPath}\nimport fs from "node:fs";fs.appendFileSync(process.env.FIXTURE_CALLS,"request\\n");console.error("private-api-credential");if(process.env.FIXTURE_DOWN==="yes")process.exit(1);console.log(JSON.stringify({kind:"Namespace",metadata:{name:"kube-system",uid:"11111111-2222-3333-4444-555555555555",labels:{private:"private-api-credential"}}}));`,
				{ mode: 0o700 },
			);
			fs.writeFileSync(
				path.join(config.configDir, "local.json"),
				JSON.stringify({
					apiVersion: "v1",
					kind: "Config",
					clusters: [
						{ name: "fixture", cluster: { server: "https://127.0.0.1:6443" } },
					],
					contexts: [
						{ name: "explicit-fixture", context: { cluster: "fixture" } },
					],
					users: [],
				}),
			);
			fs.writeFileSync(
				path.join(config.configDir, "clusters.json"),
				JSON.stringify({
					version: 1,
					clusters: [
						{
							id: "local",
							repository: config.repositories[0],
							kubeconfig: "local.json",
							context: "explicit-fixture",
							environment: {
								PATH: `${bin}:${process.env.PATH ?? ""}`,
								FIXTURE_CALLS: path.join(config.configDir, "calls.txt"),
								FIXTURE_DOWN: scenario === "unavailable" ? "yes" : "no",
							},
						},
					],
				}),
			);
		});
		let transcript = "";
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_cluster_status", { cluster: "local" }),
				{ stopReason: "toolUse" },
			),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return fauxAssistantMessage("Inspection finished");
			},
		]);
		const task = await app.startTask(invocation);
		await pendingReview(app, task, "Cluster status: local");
		const calls = path.join(config.configDir, "calls.txt");
		expect(fs.existsSync(calls)).toBe(false);
		if (scenario === "changed")
			fs.appendFileSync(path.join(config.configDir, "local.json"), "\n");
		await approve(app, task, "Cluster status: local");
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript).not.toContain("private-api-credential");
		if (scenario === "reachable") {
			expect(transcript).toContain("api-reachable");
			expect(transcript).toContain("11111111-2222-3333-4444-555555555555");
		} else {
			expect(transcript).not.toContain("api-reachable");
			if (scenario === "changed") expect(fs.existsSync(calls)).toBe(false);
		}
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
		expect(
			fs
				.readdirSync(config.stateDir)
				.some((name) => name.startsWith("cluster-inspection-")),
		).toBe(false);
	}
}, 15000);
