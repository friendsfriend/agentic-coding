import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readContainer } from "../src/environment/container-config.ts";
import { executionResult } from "../src/environment/controller/execution-result.ts";
import { validateControllerPlans } from "../src/environment/controller/plan-policy.ts";
import { runObservation } from "../src/environment/controller/run-observation.ts";
import { EnvironmentController } from "../src/environment/controller/service.ts";
import type { ControllerScope } from "../src/environment/controller/state.ts";
import { readKubernetes } from "../src/environment/kubernetes-config.ts";
import type { Plan } from "../src/environment/model.ts";
import type { EnvironmentRun } from "../src/environment/state.ts";
import { git } from "../src/git.ts";
import { createRepository } from "./fixtures/repository.ts";

const scope: ControllerScope = {
	id: "policy-scope",
	owner: 1,
	principal: { id: "agent", role: "agent" },
	host: "host",
	workspace: {
		repository: "/repo",
		directory: "/repo",
		device: "1",
		inode: "1",
		repositoryDevice: "1",
		repositoryInode: "1",
	},
	mode: "job",
	idleMs: 60000,
	state: "active",
	revision: 1,
	createdAt: 0,
};
const base: Plan = {
	app: "api",
	id: "run",
	action: "run",
	runtime: "shell",
	workspace: "/repo",
	cwd: "/repo",
	command: "serve",
	readyText: null,
	timeoutMs: 10000,
	environment: {},
	secretRefs: {},
};

test("controller plan policy preserves adapter prerequisites and rejects foreign ownership", () => {
	const container = readContainer({
		socket: "/fixture.sock",
		image: "fixture:latest",
	});
	const connection: NonNullable<Plan["clusterConnection"]> = {
		cluster: {
			id: "local",
			repositories: ["/repo"],
			kubeconfig: "/config/local",
			context: "fixture",
			environment: {},
		},
		sourceDigest: "fixture",
		server: "https://127.0.0.1:6443",
		workspace: "/repo",
		connection: {
			apiVersion: "v1",
			kind: "Config",
			clusters: [],
			contexts: [],
			users: [],
			"current-context": "fixture",
		},
	};
	const pod = readKubernetes({
		cluster: "local",
		namespace: "work",
		image: "fixture:latest",
	});
	const helm = readKubernetes({
		cluster: "local",
		namespace: "work",
		workload: "helm-release-v1",
		helm: { chart: "chart", release: "fixture" },
	});
	const plans: Plan[] = [
		base,
		{ ...base, runtime: "systemshell" },
		{ ...base, runtime: "docker", container },
		{ ...base, runtime: "podman", container },
		{
			...base,
			runtime: "compose",
			compose: {
				file: "compose.yaml",
				provider: "docker",
				socket: "/fixture.sock",
				network: "isolated",
			},
			composePlan: { digest: "fixture", services: [] },
		},
		{
			...base,
			runtime: "kubernetes",
			kubernetes: pod,
			clusterConnection: connection,
		},
		{
			...base,
			runtime: "kubernetes",
			kubernetes: helm,
			clusterConnection: connection,
			helmChart: {
				protocol: "frozen-helm-chart-v1",
				root: "/repo/chart",
				digest: "fixture",
				files: [],
				values: [],
			},
		},
	];
	for (const plan of plans)
		expect(() => validateControllerPlans([plan], scope)).not.toThrow();
	expect(() =>
		validateControllerPlans([{ ...base, workspace: "/other" }], scope),
	).toThrow("operation-plan-unavailable");
	expect(() =>
		validateControllerPlans(
			[{ ...base, runtime: "kubernetes", kubernetes: pod }],
			scope,
		),
	).toThrow("operation-plan-unavailable");
	expect(() =>
		validateControllerPlans(
			[
				{
					...base,
					runtime: "kubernetes",
					kubernetes: helm,
					clusterConnection: connection,
				},
			],
			scope,
		),
	).toThrow("operation-plan-unavailable");
});

test("execution receipts never invent startup from queue waits or success from unsuccessful exits", () => {
	const running = {
		state: "running" as const,
		exitCode: null,
		signal: null,
		plan: { action: "run" as const },
	};
	expect(executionResult([running], [running], false, false).status).toBe(
		"running",
	);
	const exited = { ...running, state: "exited" as const, exitCode: 0 };
	expect(executionResult([running], [exited], false, false).status).toBe(
		"completed",
	);
	expect(executionResult({ state: "timed-out" }, [], false, false)).toEqual({
		status: "failed",
		inspectionRequired: false,
	});
	const failed = {
		state: "exited" as const,
		exitCode: 3,
		signal: null,
		plan: { action: "test" as const },
	};
	expect(executionResult([failed], [failed], false, false).status).toBe(
		"failed",
	);
	expect(executionResult(undefined, [running], true, false)).toEqual({
		status: "unknown",
		inspectionRequired: true,
	});
});

test("receipt excerpts bound encoded output without cutting resource identities or URLs", () => {
	const status = {
		runtime: "docker" as const,
		name: "api",
		id: "original-a",
		state: "running" as const,
		health: null,
		owned: true,
		observedAt: 0,
	};
	const run: EnvironmentRun = {
		id: "run",
		batch: "batch",
		owner: 1,
		request: "request",
		plan: base,
		state: "running",
		revision: 1,
		createdAt: 0,
		pid: null,
		ready: true,
		exitCode: null,
		signal: null,
		output: `${"\0".repeat(2000)}\nretained\n`,
		error: "é".repeat(2000),
		runtimeStatuses: [
			status,
			{ ...status, name: "é".repeat(2000), id: "too-large" },
			{ ...status, id: "original-c" },
		],
	};
	const view = runObservation({
		...run,
		endpoints: {
			api: "http://127.0.0.1:8080",
			tooLarge: `http://127.0.0.1/${"x".repeat(2000)}`,
		},
	});
	expect(view.output).toBe("retained\n");
	expect(view.outputExcerpt?.truncated).toBe(true);
	expect(view.runtimeStatuses?.map((row) => row.id)).toEqual([
		"original-a",
		"original-c",
	]);
	expect(view.runtimeStatusWindow).toEqual({
		observed: 3,
		returned: 2,
		omitted: 1,
	});
	expect(view.endpoints).toEqual({ api: "http://127.0.0.1:8080" });
	expect(view.endpointWindow.omitted).toBe(1);
	expect(view.errorOmitted).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(2500);
});

test("controller runs pinned foreign prerequisites and releases shared dependencies only after their last root", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "controller-runtime-")),
	);
	const repository = path.join(root, "repo"),
		dependency = path.join(root, "dependency"),
		stateDir = path.join(root, "state"),
		configDir = path.join(root, "config");
	for (const directory of [stateDir, configDir])
		fs.mkdirSync(directory, { mode: 0o700 });
	await createRepository(repository);
	await createRepository(dependency);
	fs.writeFileSync(path.join(dependency, "version.txt"), "captured");
	fs.writeFileSync(
		path.join(dependency, "serve.js"),
		'import fs from "node:fs"; fs.writeFileSync("started.json", JSON.stringify({version:fs.readFileSync("version.txt","utf8"),uncommitted:fs.existsSync("uncommitted.txt")})); console.log("READY"); setInterval(()=>{},1000);',
	);
	await git(dependency, ["add", "version.txt", "serve.js"]);
	await git(dependency, ["commit", "-m", "dependency"]);
	const captured = (await git(dependency, ["rev-parse", "HEAD"])).trim();
	fs.writeFileSync(path.join(dependency, "uncommitted.txt"), "not copied");
	const prerequisite = [{ app: "store", target: "run" }];
	const target = (app: string) => ({
		id: "run",
		action: "run",
		runtime: "shell",
		prerequisites: prerequisite,
		timeoutMs: 10000,
		readyText: "READY",
		command: `exec '${process.execPath}' -e ${JSON.stringify(`import fs from 'node:fs'; fs.writeFileSync('${app}.started','ready'); console.log('READY'); setInterval(()=>{},1000);`)}`,
	});
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "alpha",
					kind: "app",
					repository,
					targets: [target("alpha")],
				},
				{
					id: "beta",
					kind: "app",
					repository,
					targets: [target("beta")],
				},
				{
					id: "store",
					kind: "infrastructure",
					repository: dependency,
					targets: [
						{
							id: "run",
							action: "run",
							runtime: "shell",
							command: `exec '${process.execPath}' serve.js`,
							readyText: "READY",
							timeoutMs: 10000,
						},
					],
				},
			],
		}),
	);
	let controller: EnvironmentController | undefined;
	try {
		controller = await EnvironmentController.open({
			stateDir,
			configDir,
			repositories: [repository, dependency],
		});
		const principal = { id: "fixture", role: "agent" as const };
		const scope = await controller.scopes.bind(principal).create({
			requestId: "scope",
			repository,
			workspace: repository,
			mode: "job",
			idleMs: 60000,
		});
		const bound = controller.bind(principal, scope.id);
		const operator = controller.operations.operator({
			id: "developer",
			role: "operator",
		});
		await expect(
			bound.admit("foreign-root", { action: "run", apps: ["store"] }),
		).rejects.toThrow("operation-plan-unavailable");
		const alpha = await bound.admit("alpha", {
			action: "run",
			apps: ["alpha"],
			lifetime: "shared-prerequisites-v1",
		});
		const beta = await bound.admit("beta", {
			action: "run",
			apps: ["beta"],
			lifetime: "shared-prerequisites-v1",
		});
		const frozen = JSON.parse((await operator.inspect(alpha.id)).plan) as {
			disclosure: { plans: Plan[] };
		};
		const pinned = frozen.disclosure.plans.find(
			(plan) => plan.app === "store",
		)?.dependencyWorkspace;
		if (!pinned) throw new Error("Missing captured foreign prerequisite");
		expect(pinned.commit).toBe(captured);
		expect(fs.existsSync(pinned.workspace)).toBe(false);
		for (const operation of [alpha, beta])
			await operator.decide(operation.id, {
				digest: operation.digest,
				revision: operation.revision,
				requestId: `approve-${operation.id}`,
				decision: "approved",
			});
		expect(fs.existsSync(path.join(repository, "alpha.started"))).toBe(false);
		expect(fs.existsSync(path.join(repository, "beta.started"))).toBe(false);
		await git(dependency, ["commit", "--allow-empty", "-m", "new source head"]);
		await bound.execute(alpha.id);
		expect((await bound.wait(alpha.id)).result).toContain('"status":"running"');
		await bound.execute(beta.id);
		expect((await bound.wait(beta.id)).result).toContain('"status":"running"');
		expect(
			JSON.parse(
				fs.readFileSync(path.join(pinned.workspace, "started.json"), "utf8"),
			),
		).toEqual({ version: "captured", uncommitted: false });
		expect((await git(pinned.workspace, ["rev-parse", "HEAD"])).trim()).toBe(
			captured,
		);
		expect(fs.existsSync(path.join(dependency, "started.json"))).toBe(false);
		expect(
			(await bound.status()).runs.filter((run) => run.state === "running"),
		).toHaveLength(3);
		await bound.stop("alpha-stop", ["alpha"]);
		expect((await bound.status("store")).runs[0]?.state).toBe("running");
		expect((await bound.status("alpha")).runs[0]?.state).toBe("exited");
		expect((await bound.status("beta")).runs[0]?.state).toBe("running");
		await bound.stop("beta-stop", ["beta"]);
		expect((await bound.status("store")).runs[0]?.state).toBe("exited");
		expect(
			(await bound.status()).runs.every((run) => run.state === "exited"),
		).toBe(true);
	} finally {
		await controller?.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
