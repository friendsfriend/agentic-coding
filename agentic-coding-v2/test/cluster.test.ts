import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("explicit local cluster status waits for approval, keeps API data private and does not invent reachability or reuse changed configuration", async () => {
	for (const scenario of ["reachable", "unavailable", "changed"]) {
		const { app, config, fake, invocation } = await fixture(false, (config) =>
			configureLocalCluster(
				config,
				`import fs from "node:fs";fs.appendFileSync(process.env.FIXTURE_CALLS,"request\\n");console.error("private-api-credential");if(process.env.FIXTURE_DOWN==="yes")process.exit(1);console.log(JSON.stringify({kind:"Namespace",metadata:{name:"kube-system",uid:"11111111-2222-3333-4444-555555555555",labels:{private:"private-api-credential"}}}));`,
				{
					FIXTURE_CALLS: path.join(config.configDir, "calls.txt"),
					FIXTURE_DOWN: scenario === "unavailable" ? "yes" : "no",
				},
			),
		);
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

test("a shared cluster lists every authorized repository explicitly and refuses unlisted or mixed forms", async () => {
	for (const [label, entry, accepted] of [
		["listed", (repo: string) => ({ repositories: [repo] }), true],
		[
			"unlisted",
			(_repo: string, other: string) => ({ repositories: [other] }),
			false,
		],
		[
			"mixed",
			(repo: string) => ({ repository: repo, repositories: [repo] }),
			"invalid",
		],
		["empty", () => ({ repositories: [] }), "invalid"],
	] as const) {
		const opened = await fixture(false, (config) => {
			configureLocalCluster(
				config,
				`console.log(JSON.stringify({kind:"Namespace",metadata:{name:"kube-system",uid:"11111111-2222-3333-4444-555555555555"}}));`,
			);
			// A second authorized repository the cluster may or may not list.
			const other = fs.realpathSync(
				fs.mkdtempSync(path.join(path.dirname(config.configDir), "other-")),
			);
			config.repositories.push(other);
			const file = path.join(config.configDir, "clusters.json"),
				document = JSON.parse(fs.readFileSync(file, "utf8"));
			const cluster = document.clusters[0];
			delete cluster.repository;
			Object.assign(cluster, entry(config.repositories[0] ?? "", other));
			fs.writeFileSync(file, JSON.stringify(document));
		}).then(
			(value) => value,
			(error: unknown) => error as Error,
		);
		if (opened instanceof Error) {
			expect(accepted, label).toBe("invalid");
			expect(opened.message).toContain(
				"Invalid explicit cluster configuration",
			);
			continue;
		}
		expect(accepted, label).not.toBe("invalid");
		const { app, fake, invocation } = opened;
		let transcript = "";
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_cluster_status", { cluster: "local" }),
				{ stopReason: "toolUse" },
			),
			(messages) => {
				transcript = JSON.stringify(messages.messages);
				return fauxAssistantMessage("done");
			},
		]);
		const task = await app.startTask(invocation);
		if (accepted === true) {
			await pendingReview(app, task, "Cluster status: local");
			await approve(app, task, "Cluster status: local");
		}
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript.includes("api-reachable"), label).toBe(accepted === true);
	}
}, 30000);

const originalPath = process.env.PATH;
test("without clusters.json every authorized repository sees v1's implicit devenv kind cluster, and status never creates it", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		const bin = path.join(config.configDir, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(
			path.join(bin, "kind"),
			`#!/bin/sh\necho "$*" >> "${path.join(config.configDir, "kind-calls.txt")}"\n[ "$1 $2" = "get clusters" ] && exit 0\nexit 1\n`,
			{ mode: 0o700 },
		);
		fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n", {
			mode: 0o700,
		});
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
	});
	process.env.PATH = originalPath;
	expect((await app.environments.snapshot()).clusters).toEqual([
		expect.objectContaining({
			id: "devenv",
			context: "kind-devenv",
			repositories: config.repositories,
			provision: { tool: "kind", name: "devenv", provider: "docker" },
		}),
	]);
	let transcript = "";
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_cluster_status", { cluster: "devenv" }),
			{ stopReason: "toolUse" },
		),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("done");
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Cluster status: devenv");
	await approve(app, task, "Cluster status: devenv");
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("does not exist yet");
	expect(transcript).not.toContain("api-reachable");
	expect(
		fs.readFileSync(path.join(config.configDir, "kind-calls.txt"), "utf8"),
	).toBe("get clusters\n");
}, 30000);

test("an existing kind cluster imports as private file references and is usable by every listed repository", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		configureLocalCluster(
			config,
			`console.log(JSON.stringify({kind:"Namespace",metadata:{name:"kube-system",uid:"11111111-2222-3333-4444-555555555555"}}));`,
		);
		fs.writeFileSync(
			path.join(config.configDir, "config.json"),
			JSON.stringify({ profiles: {}, repositories: config.repositories }),
		);
		const bin = path.join(config.configDir, "bin"),
			data = (value: string) => Buffer.from(value).toString("base64");
		fs.writeFileSync(
			path.join(bin, "kind"),
			`#!/bin/sh\n[ "$*" = "get kubeconfig --name devenv" ] || exit 1\ncat <<'EOF2'\napiVersion: v1\nkind: Config\nclusters:\n- name: kind-devenv\n  cluster:\n    server: https://127.0.0.1:6443\n    certificate-authority-data: ${data("private-ca")}\ncontexts:\n- name: kind-devenv\n  context: {cluster: kind-devenv, user: kind-devenv}\nusers:\n- name: kind-devenv\n  user:\n    client-certificate-data: ${data("private-cert")}\n    client-key-data: ${data("private-key")}\nEOF2\n`,
			{ mode: 0o700 },
		);
		const result = Bun.spawnSync(
			[
				process.execPath,
				path.join(import.meta.dir, "../scripts/import-kind-cluster.ts"),
				"--config-dir",
				config.configDir,
				"--repository",
				config.repositories[0] ?? "",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			},
		);
		const output = result.stdout.toString() + result.stderr.toString();
		if (result.exitCode !== 0) throw new Error(output);
		for (const secret of ["private-ca", "private-cert", "private-key"])
			expect(output).not.toContain(secret);
		const file = path.join(config.configDir, "clusters.json"),
			document = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(document.clusters).toHaveLength(2);
		const imported = document.clusters.find(
			(entry: { id: string }) => entry.id === "devenv",
		);
		expect(imported).toMatchObject({
			context: "kind-devenv",
			repositories: config.repositories,
			kubeconfig: path.join("clusters", "devenv", "kubeconfig.json"),
		});
		for (const secret of ["private-ca", "private-cert", "private-key"])
			expect(fs.readFileSync(file, "utf8")).not.toContain(secret);
		const key = path.join(config.configDir, "clusters", "devenv", "client.key");
		expect(fs.readFileSync(key, "utf8")).toBe("private-key");
		expect(fs.statSync(key).mode & 0o777).toBe(0o600);
		// The fixture kubectl stays on the imported PATH; no real API is called.
		imported.environment = document.clusters[0].environment;
		fs.writeFileSync(file, JSON.stringify(document));
	});
	let transcript = "";
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_cluster_status", { cluster: "devenv" }),
			{ stopReason: "toolUse" },
		),
		(messages) => {
			transcript = JSON.stringify(messages.messages);
			return fauxAssistantMessage("done");
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Cluster status: devenv");
	await approve(app, task, "Cluster status: devenv");
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript).toContain("api-reachable");
	for (const secret of ["private-ca", "private-cert", "private-key"])
		expect(transcript).not.toContain(secret);
}, 30000);
