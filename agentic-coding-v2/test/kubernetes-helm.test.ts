import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { helmClient, helmDeploymentClient } from "./fixtures/helm-client.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const stateFile = (config: Config) =>
	path.join(config.configDir, "helm-state.json");
const callsFile = (config: Config) =>
	path.join(config.configDir, "helm-calls.jsonl");
const read = (config: Config) =>
	JSON.parse(fs.readFileSync(stateFile(config), "utf8"));
const calls = (config: Config) =>
	fs.existsSync(callsFile(config))
		? fs
				.readFileSync(callsFile(config), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const chartFiles: Record<string, string> = {
	"Chart.yaml":
		"apiVersion: v2\nname: fixture\nversion: 0.1.0\ntype: application\n",
	"values.yaml": "replicaCount: 1\nstage: local\n",
	"values-dev.yaml": "stage: dev\n",
	"templates/configmap.yaml":
		"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\ndata:\n  stage: {{ .Values.stage }}\n",
	"templates/external-secret.yaml":
		"apiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: fixture\n",
};
function commit(config: Config, files: Record<string, string>) {
	const repo = config.repositories[0] ?? "";
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(repo, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	for (const argv of [
		["add", "-A"],
		["commit", "-m", "chart"],
	])
		if (Bun.spawnSync(["git", ...argv], { cwd: repo }).exitCode !== 0)
			throw new Error("Fixture chart commit failed");
}
function configure(
	config: Config,
	options: {
		files?: Record<string, string>;
		state?: Record<string, unknown>;
		helm?: Record<string, unknown>;
	} = {},
) {
	fs.chmodSync(config.stateDir, 0o700);
	commit(
		config,
		Object.fromEntries(
			Object.entries(options.files ?? chartFiles).map(([name, content]) => [
				`chart/${name}`,
				content,
			]),
		),
	);
	configureLocalCluster(config, helmDeploymentClient, {
		FIXTURE_STATE: stateFile(config),
		FIXTURE_CALLS: callsFile(config),
	});
	fs.writeFileSync(
		path.join(config.configDir, "bin", "helm"),
		`#!${process.execPath}\n${helmClient}`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		stateFile(config),
		JSON.stringify({ releases: {}, ...options.state }),
	);
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					targets: [
						{
							id: "release",
							action: "run",
							runtime: "kubernetes",
							timeoutMs: 8000,
							kubernetes: {
								cluster: "local",
								namespace: "fixtures",
								workload: "helm-release-v1",
								helm: {
									chart: "chart",
									release: "api-local",
									values: ["values-dev.yaml"],
									setString: { "app.imageTag": "v1" },
									replicasValuePath: "replicaCount",
									...options.helm,
								},
							},
						},
					],
				},
			],
		}),
	);
}
async function held(
	value: Awaited<ReturnType<typeof fixture>>,
	start: Record<string, unknown> = {},
) {
	const { app, fake, invocation } = value;
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_start", {
				apps: ["api"],
				runtime: "kubernetes",
				...start,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("request_review", { path: ".", title: "Hold release" }),
			{ stopReason: "toolUse" },
		),
	]);
	const owner = await app.startTask(invocation);
	const review = await pendingReview(app, owner);
	expect(review.snapshot).toContain("kubernetesHelmScope");
	expect(review.snapshot).not.toContain('"kubernetesScope"');
	expect(review.snapshot).not.toContain('"kubernetesDeploymentScope"');
	expect(calls(value.config)).toHaveLength(0);
	await approve(app, owner);
	return owner;
}

test("explicit Helm release installs one frozen chart revision, observes its own label and uninstalls only that release", async () => {
	const value = await fixture(false, configure),
		{ app, config } = value;
	const owner = await held(value, { replicas: 2 });
	await pendingReview(app, owner, "Hold release");
	const release = read(config).releases["fixtures/api-local"];
	expect(release).toMatchObject({ revision: 1, status: "deployed" });
	const install = calls(config).find((call) => call.verb === "install");
	expect(install.args).toEqual(
		expect.arrayContaining([
			"--namespace",
			"fixtures",
			"--set-string",
			"app.imageTag=v1",
			"--set",
			"replicaCount=2",
			"--skip-crds",
			"--no-hooks",
		]),
	);
	for (const forbidden of [
		"upgrade",
		"--create-namespace",
		"--replace",
		"--take-ownership",
		"--force-replace",
		"--post-renderer",
		"--rollback-on-failure",
	])
		expect(install.args).not.toContain(forbidden);
	// The private frozen copy, not the task checkout, is installed.
	expect(install.chartFiles).toEqual(
		expect.arrayContaining(["Chart.yaml", "templates", "values-dev.yaml"]),
	);
	const chartPath = install.args[install.args.indexOf("api-local") + 1];
	expect(chartPath).toContain(path.join(config.stateDir, "helm-chart-"));
	expect(install.values).toEqual(["stage: dev\n"]);
	expect(release.labels.acv2run).toMatch(/^[a-f0-9]{32}$/);
	expect(install.args).not.toContain("--wait=watcher");
	expect(calls(config).map((call) => call.verb)).toEqual(
		expect.arrayContaining(["template", "install", "kubectl-get"]),
	);
	expect(
		calls(config).findIndex((call) => call.verb === "template"),
	).toBeLessThan(calls(config).findIndex((call) => call.verb === "install"));
	expect(install.helmHome).toContain(
		path.join(config.stateDir, "cluster-inspection-"),
	);
	expect(install.env).toEqual(
		expect.arrayContaining([
			"HELM_CONFIG_HOME",
			"HELM_DRIVER",
			"HELM_NO_PLUGINS",
		]),
	);
	const statuses = (await app.environments.snapshot()).runs[0]?.runtimeStatuses;
	expect(statuses?.[0]).toMatchObject({
		kind: "helm-release",
		readiness: "helm-deployments-available",
		health: "healthy",
		owned: true,
		id: "fixtures/api-local@1",
	});
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
	expect(read(config).releases).toEqual({});
	const uninstall = calls(config).filter((call) => call.verb === "uninstall");
	expect(uninstall).toHaveLength(1);
	expect(uninstall[0].args).toEqual(
		expect.arrayContaining(["--cascade", "foreground", "--no-hooks"]),
	);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe("exited");
	expect(
		fs
			.readdirSync(config.stateDir)
			.some((name) => name.startsWith("helm-chart-")),
	).toBe(false);
}, 30000);

test("an occupied release name is never adopted, upgraded or uninstalled", async () => {
	const value = await fixture(false, (config) =>
			configure(config, {
				state: {
					releases: {
						"fixtures/api-local": {
							name: "api-local",
							namespace: "fixtures",
							revision: 3,
							status: "deployed",
							labels: {},
						},
					},
				},
			}),
		),
		{ app, config } = value;
	const owner = await held(value);
	await eventually(
		() => app.environments.snapshot(),
		(snapshot) => snapshot.runs[0]?.state === "exited",
	);
	expect(read(config).releases["fixtures/api-local"].revision).toBe(3);
	expect(
		calls(config).filter((call) =>
			["install", "uninstall"].includes(call.verb),
		),
	).toHaveLength(0);
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
}, 30000);

for (const failure of ["revision-change", "label-replaced", "missing"] as const)
	test(`a ${failure} release fails without uninstalling a replacement`, async () => {
		const value = await fixture(false, configure),
			{ app, config } = value;
		const owner = await held(value);
		await pendingReview(app, owner, "Hold release");
		const state = read(config),
			release = state.releases["fixtures/api-local"];
		if (failure === "revision-change") release.revision = 2;
		else if (failure === "label-replaced")
			release.labels = { acv2run: "copied" };
		else delete state.releases["fixtures/api-local"];
		fs.writeFileSync(stateFile(config), JSON.stringify(state));
		await eventually(
			() => app.environments.snapshot(),
			(snapshot) => snapshot.runs[0]?.state === "interrupted",
		);
		expect(
			calls(config).filter((call) => call.verb === "uninstall"),
		).toHaveLength(0);
		if (failure !== "missing")
			expect(read(config).releases["fixtures/api-local"]).toBeDefined();
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);

for (const failure of [
	"installFails",
	"invalidReceipt",
	"wrongRevision",
] as const)
	test(`Helm ${failure} never reports ready and uses only original-receipt cleanup`, async () => {
		const value = await fixture(false, (config) =>
				configure(config, { state: { [failure]: true } }),
			),
			{ app, config } = value;
		const owner = await held(value);
		await eventually(
			() => app.environments.snapshot(),
			(snapshot) =>
				["interrupted", "exited"].includes(String(snapshot.runs[0]?.state)),
		);
		const run = (await app.environments.snapshot()).runs[0];
		expect(run?.ready).not.toBe(true);
		// Without an original deployed receipt, the half-installed release is
		// retained for inspection and the slot is quarantined, never adopted.
		expect(run?.state).toBe("interrupted");
		expect(
			calls(config).filter((call) => call.verb === "uninstall"),
		).toHaveLength(0);
		expect(read(config).releases["fixtures/api-local"]).toBeDefined();
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);

test("uninstall that does not remove the original release quarantines the slot", async () => {
	const value = await fixture(false, (config) =>
			configure(config, { state: { keepOnUninstall: true } }),
		),
		{ app, config } = value;
	const owner = await held(value);
	await pendingReview(app, owner, "Hold release");
	await app.cancel(owner);
	await app.harness.waitForTask(owner as TaskId, context);
	expect((await app.environments.snapshot()).runs[0]?.state).toBe(
		"interrupted",
	);
	expect(read(config).releases["fixtures/api-local"]).toBeDefined();
}, 30000);

test("a chart changed after review refuses before any Helm mutation", async () => {
	const value = await fixture(false, configure),
		{ app, config, fake, invocation } = value;
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("env_start", { apps: ["api"], runtime: "kubernetes" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done"),
	]);
	const owner = await app.startTask(invocation);
	const review = await pendingReview(app, owner);
	expect(review.snapshot).toContain("kubernetesHelmScope");
	const task = (await app.snapshot()).tasks.find((item) => item.id === owner);
	if (!task?.workspace) throw new Error("Missing task workspace");
	fs.appendFileSync(
		path.join(task.workspace, "chart", "templates", "configmap.yaml"),
		"  drift: true\n",
	);
	await approve(app, owner);
	await app.harness.waitForTask(owner as TaskId, context);
	expect(
		calls(config).filter((call) =>
			["install", "uninstall"].includes(call.verb),
		),
	).toHaveLength(0);
	expect(read(config).releases).toEqual({});
}, 30000);

for (const [label, files, message] of [
	[
		"hook",
		{
			...chartFiles,
			"templates/job.yaml":
				"metadata:\n  annotations:\n    helm.sh/hook: pre-install\n",
		},
		"Helm hooks and resource-policy",
	],
	[
		"keep policy",
		{
			...chartFiles,
			"templates/pvc.yaml":
				"metadata:\n  annotations:\n    helm.sh/resource-policy: keep\n",
		},
		"Helm hooks and resource-policy",
	],
	[
		"lookup",
		{
			...chartFiles,
			"templates/secret.yaml": '{{ (lookup "v1" "Secret" "x" "y") }}\n',
		},
		"Helm lookup renders from live cluster state",
	],
	[
		"CRDs",
		{ ...chartFiles, "crds/x.yaml": "kind: CustomResourceDefinition\n" },
		"Helm chart CRDs are cluster-scoped",
	],
	[
		"dependencies",
		{
			...chartFiles,
			"Chart.yaml": `${chartFiles["Chart.yaml"]}dependencies:\n  - name: x\n    version: 1.0.0\n`,
		},
		"Helm chart dependencies/subcharts",
	],
] as const)
	test(`Helm ${label} refuses at plan resolution before review or any Helm call`, async () => {
		const value = await fixture(false, (config) =>
				configure(config, { files: { ...files } }),
			),
			{ app, config, fake, invocation } = value;
		let payload = "";
		fake.setResponses([
			fauxAssistantMessage(
				fauxToolCall("env_start", { apps: ["api"], runtime: "kubernetes" }),
				{ stopReason: "toolUse" },
			),
			(messages) => {
				payload = JSON.stringify(
					messages.messages.filter((message) => message.role === "toolResult"),
				);
				return fauxAssistantMessage("Done");
			},
		]);
		const owner = await app.startTask(invocation);
		await app.harness.waitForTask(owner as TaskId, context);
		expect(payload).toContain(message);
		expect(calls(config)).toHaveLength(0);
	}, 30000);

for (const [label, helm] of [
	["outside values", { values: ["../values.yaml"] }],
	["structured setString", { setString: { "a.b": "x,y=z" } }],
	["indexed setString path", { setString: { "a[0]": "x" } }],
	["unknown Helm field", { postRenderer: "x" }],
] as const)
	test(`Helm ${label} is refused by the configuration schema`, async () => {
		const { config } = await fixture(false, (config) => configure(config));
		const { validateProjects } = await import("../src/environment/catalog.ts");
		const document = JSON.parse(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		);
		expect(validateProjects(config, document)).toHaveLength(1);
		Object.assign(document.projects[0].targets[0].kubernetes.helm, helm);
		expect(() => validateProjects(config, document)).toThrow(/Helm/);
		expect(calls(config)).toHaveLength(0);
	}, 30000);

for (const [label, extra] of [
	["environment", { environment: { A: "b" } }],
	["secret references", { secretRefs: { A: "B" } }],
	["image fields", { kubernetes: { image: "x" } }],
] as const)
	test(`Helm targets refuse ${label} rather than binding them outside the chart`, async () => {
		const { config } = await fixture(false, (config) => configure(config));
		const { validateProjects } = await import("../src/environment/catalog.ts");
		const document = JSON.parse(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		);
		const target = document.projects[0].targets[0];
		if ("kubernetes" in extra)
			Object.assign(target.kubernetes, extra.kubernetes);
		else Object.assign(target, extra);
		expect(() => validateProjects(config, document)).toThrow(/Helm/);
	}, 30000);

const deployment = (namespace: string) =>
	`apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: ${namespace}\n`;
for (const [label, manifest] of [
	["another namespace", deployment("other")],
	[
		"a cluster-scoped object",
		`${deployment("fixtures")}---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: x\n`,
	],
	["no Deployment", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n"],
] as const)
	test(`an offline render with ${label} refuses before any cluster effect`, async () => {
		const value = await fixture(false, (config) =>
				configure(config, { state: { manifest } }),
			),
			{ app, config } = value;
		const owner = await held(value);
		await eventually(
			() => app.environments.snapshot(),
			(snapshot) => snapshot.runs[0]?.state === "exited",
		);
		expect(calls(config).map((call) => call.verb)).not.toContain("install");
		expect(read(config).releases).toEqual({});
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);

test("the default namespace is accepted like v1 and readiness waits for Available Deployments", async () => {
	const value = await fixture(false, (config) =>
			configure(config, { state: { unavailable: true } }),
		),
		{ config } = value;
	const document = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	);
	document.projects[0].targets[0].kubernetes.namespace = "default";
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify(document),
	);
	const reopened = await value.open();
	const owner = await held({ ...value, app: reopened });
	await eventually(
		() => reopened.environments.snapshot(),
		(snapshot) =>
			snapshot.runs[0]?.runtimeStatuses?.[0]?.health === "starting" &&
			read(config).releases["default/api-local"] !== undefined,
	);
	expect(
		(await reopened.environments.snapshot()).runs[0]?.runtimeStatuses?.[0]
			?.health,
	).toBe("starting");
	const state = read(config);
	state.unavailable = false;
	fs.writeFileSync(stateFile(config), JSON.stringify(state));
	await pendingReview(reopened, owner, "Hold release");
	expect(
		(await reopened.environments.snapshot()).runs[0]?.runtimeStatuses?.[0],
	).toMatchObject({ state: "running", health: "healthy" });
	await reopened.cancel(owner);
	await reopened.harness.waitForTask(owner as TaskId, context);
	expect(read(config).releases).toEqual({});
}, 30000);

for (const [label, state] of [
	["a Deployment owned by another release", { foreignDeployment: true }],
	[
		"an installed manifest differing from the render",
		{
			installedManifest:
				"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\n",
		},
	],
] as const)
	test(`${label} fails readiness and uninstalls only the original release`, async () => {
		const value = await fixture(false, (config) =>
				configure(config, { state }),
			),
			{ app, config } = value;
		const owner = await held(value);
		await eventually(
			() => app.environments.snapshot(),
			(snapshot) => snapshot.runs[0]?.state === "exited",
		);
		expect((await app.environments.snapshot()).runs[0]?.ready).not.toBe(true);
		expect(
			calls(config).filter((call) => call.verb === "uninstall"),
		).toHaveLength(1);
		expect(read(config).releases).toEqual({});
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
	}, 30000);

const kindClient = `import fs from "node:fs";
const file=process.env.FIXTURE_KIND,calls=process.env.FIXTURE_CALLS;
const s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{clusters:[]};
const args=process.argv.slice(2);
fs.appendFileSync(calls,JSON.stringify({verb:"kind-"+args.slice(0,2).join("-"),args,kubeconfig:process.env.KUBECONFIG})+"\\n");
const b=(v)=>Buffer.from(v).toString("base64");
if(args[0]==="get"&&args[1]==="clusters"){console.log(s.clusters.join("\\n"));}
else if(args[0]==="create"&&args[1]==="cluster"){s.clusters.push(args[3]);fs.writeFileSync(file,JSON.stringify(s));console.error("Creating cluster");}
else if(args[0]==="get"&&args[1]==="kubeconfig"){
 if(!s.clusters.includes(args[3]))process.exit(1);
 console.log(["apiVersion: v1","kind: Config","clusters:","- name: kind-"+args[3],"  cluster:","    server: https://127.0.0.1:6443","    certificate-authority-data: "+b("private-ca"),"contexts:","- name: kind-"+args[3],"  context: {cluster: kind-"+args[3]+", user: kind-"+args[3]+"}","users:","- name: kind-"+args[3],"  user:","    client-certificate-data: "+b("private-cert"),"    client-key-data: "+b("private-key")].join("\\n"));
}else process.exit(2);
`;
test("a Helm run on v1's kind cluster creates it when missing, reuses it after and never deletes it", async () => {
	const value = await fixture(false, (config) => {
			configure(config);
			const bin = path.join(config.configDir, "bin");
			fs.writeFileSync(
				path.join(bin, "kind"),
				`#!${process.execPath}\n${kindClient}`,
				{ mode: 0o700 },
			);
			fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n", {
				mode: 0o700,
			});
			fs.writeFileSync(
				path.join(config.configDir, "clusters.json"),
				JSON.stringify({
					version: 1,
					clusters: [
						{
							id: "devenv",
							repositories: config.repositories,
							provision: { tool: "kind", name: "devenv" },
							environment: {
								PATH: `${bin}:${process.env.PATH ?? ""}`,
								FIXTURE_STATE: stateFile(config),
								FIXTURE_CALLS: callsFile(config),
								FIXTURE_KIND: path.join(config.configDir, "kind.json"),
							},
						},
					],
				}),
			);
			const file = path.join(config.configDir, "environments.json"),
				document = JSON.parse(fs.readFileSync(file, "utf8"));
			document.projects[0].targets[0].kubernetes.cluster = "devenv";
			fs.writeFileSync(file, JSON.stringify(document));
		}),
		{ app, config } = value;
	expect((await app.environments.snapshot()).clusters).toEqual([
		expect.objectContaining({
			id: "devenv",
			context: "kind-devenv",
			provision: { tool: "kind", name: "devenv", provider: "docker" },
		}),
	]);
	for (const round of [0, 1]) {
		const owner = await held({
			...value,
			invocation: { ...value.invocation, requestId: `kind-${round}` },
		});
		if (round === 0)
			expect(
				(await app.snapshot()).reviews.some(
					(review) =>
						review.taskId === owner &&
						review.snapshot.includes("clusterProvisionScope"),
				),
			).toBe(true);
		await pendingReview(app, owner, "Hold release");
		expect(read(config).releases["fixtures/api-local"]).toMatchObject({
			status: "deployed",
		});
		await app.cancel(owner);
		await app.harness.waitForTask(owner as TaskId, context);
		expect(read(config).releases).toEqual({});
		fs.writeFileSync(callsFile(config), "");
		if (round === 0) {
			const kubeconfig = path.join(
				config.configDir,
				"clusters",
				"devenv",
				"kubeconfig.json",
			);
			for (const secret of ["private-ca", "private-cert", "private-key"])
				expect(fs.readFileSync(kubeconfig, "utf8")).not.toContain(secret);
			const key = path.join(
				config.configDir,
				"clusters",
				"devenv",
				"client.key",
			);
			expect(fs.readFileSync(key, "utf8")).toBe("private-key");
			expect(fs.statSync(key).mode & 0o777).toBe(0o600);
		}
	}
	const kind = JSON.parse(
		fs.readFileSync(path.join(config.configDir, "kind.json"), "utf8"),
	);
	expect(kind.clusters).toEqual(["devenv"]);
	expect(JSON.stringify(await app.environments.snapshot())).not.toContain(
		"private-key",
	);
}, 60000);
