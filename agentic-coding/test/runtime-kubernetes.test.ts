// Kubernetes runtime parity (`port-environment-runtimes-to-bun`, task 1.2/3.x).
//
// Ported from `server/pkg/kubernetes/{runtime_test,image_test,secrets_test,
// status_logs_test,cluster_service_test}.go` and
// `server/pkg/build/kubernetes_logs.go`. Every command is asserted as argv, so
// the parity claim is about the exact commands the Go implementation ran.
import { describe, expect, test } from "bun:test";
import {
	buildSecretPlans,
	clusterListContains,
	helmImageOverrides,
	identityArchive,
	identityEnv,
	isKindPodmanListBug,
	isShortImageName,
	KubernetesClusterService,
	type KubernetesExec,
	logsCommand,
	mapHelmStatus,
	parseBytes,
	parseKubernetesVersion,
	parseMemoryPair,
	parseNodes,
	parsePercent,
	parsePods,
	parseReleases,
	parseRuntimeStatsJson,
	parseRuntimeStatsTab,
	planKubernetesDeployment,
	portForwardCommand,
	Runner,
	redactSecretCommand,
	resolveIdentity,
	resolveImageBuild,
	resolveImageReference,
	startClusterStatusWatcher,
} from "../src/server/runtime/kubernetes.ts";

const DOCKER = new Runner({
	containerCommand: "docker",
	containerName: "docker",
	lookPath: () => "/bin/tool",
});

const PODMAN = new Runner({
	containerCommand: "podman",
	containerName: "podman",
	lookPath: () => "/bin/tool",
});

function argv(command: { name: string; args: string[] }): string {
	return `${command.name} ${command.args.join(" ")}`;
}

describe("runner commands (Go runtime_test.go fixture)", () => {
	test("kubectl and helm target the managed context", () => {
		expect(DOCKER.kubectl("get", "pods").args).toEqual([
			"--context",
			"kind-devenv",
			"get",
			"pods",
		]);
		expect(DOCKER.helm("install", "app", "./chart").args).toEqual([
			"--kube-context",
			"kind-devenv",
			"install",
			"app",
			"./chart",
		]);
	});

	test("kind lifecycle commands carry the cluster name", () => {
		expect(DOCKER.kindCreateCluster().args).toEqual([
			"create",
			"cluster",
			"--name",
			"devenv",
		]);
		expect(DOCKER.kindDeleteCluster().args).toEqual([
			"delete",
			"cluster",
			"--name",
			"devenv",
		]);
		expect(DOCKER.kindExportKubeconfig().args).toEqual([
			"export",
			"kubeconfig",
			"--name",
			"devenv",
		]);
	});

	test("only podman sets KIND_EXPERIMENTAL_PROVIDER", () => {
		expect(DOCKER.kindCreateCluster().env).toEqual([]);
		const expected = ["KIND_EXPERIMENTAL_PROVIDER=podman"];
		expect(PODMAN.kindCreateCluster().env).toEqual(expected);
		expect(PODMAN.kindLoadImage("app:dev").env).toEqual(expected);
		expect(PODMAN.kindDeleteCluster().env).toEqual(expected);
	});

	test("preflight fails on a missing tool with Go's message", () => {
		const runner = new Runner({
			containerCommand: "docker",
			lookPath: (name) => (name === "helm" ? undefined : `/bin/${name}`),
		});
		expect(() => runner.preflight()).toThrow(
			'missing required Kubernetes tool "helm"',
		);
	});
});

describe("identity (Go identity.go fixture)", () => {
	test("resolves provider, cluster and context defaults", () => {
		expect(resolveIdentity("", "", "")).toEqual({
			provider: "docker",
			cluster: "devenv",
			context: "kind-devenv",
		});
		expect(resolveIdentity("podman", "team", "kind-team")).toEqual({
			provider: "podman",
			cluster: "team",
			context: "kind-team",
		});
		expect(identityEnv(resolveIdentity("podman", "", ""))).toEqual([
			"KIND_EXPERIMENTAL_PROVIDER=podman",
		]);
		expect(identityArchive("app/build:dev")).toBe(
			"/tmp/devenv-image-app-build-dev.tar",
		);
	});
});

describe("cluster status (Go cluster_service_test.go fixture)", () => {
	const outputs: Record<string, string> = {
		"kind get clusters": "devenv\n",
		"kubectl --context kind-devenv version -o json":
			'{"serverVersion":{"gitVersion":"v1.29.0"}}',
		"kubectl --context kind-devenv get nodes -o json":
			'{"items":[{"metadata":{"name":"devenv-control-plane"},"status":{"nodeInfo":{"kubeletVersion":"v1.29.0"},"conditions":[{"type":"Ready","status":"True"}]}}]}',
		"kubectl --context kind-devenv get pods --all-namespaces -o json":
			'{"items":[{"metadata":{"namespace":"apps"},"status":{"phase":"Running"}},{"metadata":{"namespace":"apps"},"status":{"phase":"Failed"}}]}',
		"helm --kube-context kind-devenv list --all-namespaces -o json":
			'[{"name":"api","namespace":"apps","status":"deployed","chart":"api-0.1.0","revision":"1"}]',
		"docker ps --format {{.Names}}": "devenv-control-plane\n",
		"docker stats --no-stream --format {{json .}} devenv-control-plane":
			'{"CPUPerc":"12.5%","MemUsage":"128MiB / 1GiB","MemPerc":"12.5%"}',
	};

	function execFor(
		overrides: Record<string, { stdout?: string; error?: Error }> = {},
		recorded?: string[],
	): KubernetesExec {
		return async (command) => {
			const key = argv(command);
			recorded?.push(key);
			const override = overrides[key];
			if (override) {
				return {
					stdout: override.stdout ?? "",
					stderr: "",
					...(override.error ? { error: override.error } : {}),
				};
			}
			if (key in outputs) return { stdout: outputs[key], stderr: "" };
			return { stdout: "", stderr: "" };
		};
	}

	test("parses the cluster summary, pods, releases and node stats", async () => {
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: execFor(),
			now: () => 10_000,
		});
		const status = await service.status();
		expect(status.state).toBe("running");
		expect(status.exists).toBe(true);
		expect(status.reachable).toBe(true);
		expect(status.kubernetesVersion).toBe("v1.29.0");
		expect(status.nodes).toEqual([
			{ name: "devenv-control-plane", ready: true, kubeletVersion: "v1.29.0" },
		]);
		expect(status.pods).toEqual({
			total: 2,
			running: 1,
			pending: 0,
			succeeded: 0,
			failed: 1,
			unknown: 0,
		});
		expect(status.namespaces).toEqual([{ name: "apps", pods: 2 }]);
		expect(status.releases).toEqual([
			{
				name: "api",
				namespace: "apps",
				status: "deployed",
				chart: "api-0.1.0",
				revision: "1",
			},
		]);
		expect(status.stats?.cpuPercent).toBe(12.5);
		expect(status.stats?.memoryUsageBytes).toBe(128 * 1024 * 1024);
		expect(status.collectedAt).toBe(new Date(10_000).toISOString());
	});

	test("a missing cluster is `missing` and runs no kubectl", async () => {
		const recorded: string[] = [];
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: execFor({ "kind get clusters": { stdout: "other\n" } }, recorded),
		});
		const status = await service.status();
		expect(status.state).toBe("missing");
		expect(recorded).toEqual(["kind get clusters"]);
	});

	test("the known kind podman list bug falls back to the runtime, not absence", async () => {
		const bug = new Error(
			"kind get clusters: using podman due to KIND_EXPERIMENTAL_PROVIDER\nfailed to list clusters: cannot index slice/array with type string",
		);
		const present = new KubernetesClusterService({
			runner: PODMAN,
			exec: execFor({
				"kind get clusters": { error: bug },
				"podman ps -a --format {{.Names}}": {
					stdout: "devenv-control-plane\n",
				},
			}),
		});
		const withCluster = await present.status();
		// The cluster is adopted from the runtime, so it is never reported
		// missing (and therefore never recreated).
		expect(withCluster.exists).toBe(true);
		expect(withCluster.state).not.toBe("missing");

		const absent = new KubernetesClusterService({
			runner: PODMAN,
			exec: execFor({
				"kind get clusters": { error: bug },
				"podman ps -a --format {{.Names}}": { stdout: "" },
			}),
		});
		const withoutCluster = await absent.status();
		expect(withoutCluster.exists).toBe(false);
		expect(withoutCluster.state).toBe("missing");
	});

	test("an unrelated kind failure is a warning, never a missing cluster", async () => {
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: execFor({
				"kind get clusters": { error: new Error("kind: command not found") },
			}),
		});
		const status = await service.status();
		expect(status.exists).toBe(false);
		expect(status.state).toBe("missing");
		expect(status.warnings?.length).toBe(1);
	});

	test("an unreachable cluster stays unreachable and is never recreated", async () => {
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: execFor({
				"kubectl --context kind-devenv version -o json": {
					error: new Error("connection refused"),
				},
			}),
		});
		const status = await service.status();
		expect(status.exists).toBe(true);
		expect(status.reachable).toBe(false);
		expect(status.state).toBe("unreachable");
	});

	test("a failed node read degrades instead of reporting running", async () => {
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: execFor({
				"kubectl --context kind-devenv get nodes -o json": {
					error: new Error("nodes unavailable"),
				},
			}),
		});
		const status = await service.status();
		expect(status.state).toBe("degraded");
		expect(status.warnings?.length).toBeGreaterThan(0);
	});

	test("isKindPodmanListBug only matches Go's exact failure signature", () => {
		expect(
			isKindPodmanListBug(
				new Error(
					"KIND_EXPERIMENTAL_PROVIDER failed to list clusters cannot index slice/array with type string",
				),
			),
		).toBe(true);
		expect(isKindPodmanListBug(new Error("kind: command not found"))).toBe(
			false,
		);
	});

	test("clusterListContains matches whole fields only", () => {
		expect(clusterListContains("devenv\nother\n", "devenv")).toBe(true);
		expect(clusterListContains("devenv-2\n", "devenv")).toBe(false);
	});
});

describe("cluster lifecycle (Go cluster_service_test.go fixture)", () => {
	test("create observes its lifecycle commands", async () => {
		const observed: string[] = [];
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: async (command) => {
				observed.push(argv(command));
				if (argv(command) === "kind get clusters")
					return { stdout: "devenv\n", stderr: "" };
				return { stdout: "exported", stderr: "" };
			},
		});
		await service.create();
		expect(observed).toEqual([
			"kind get clusters",
			"kind export kubeconfig --name devenv",
		]);
	});

	test("create makes the cluster when it is absent", async () => {
		const observed: string[] = [];
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: async (command) => {
				observed.push(argv(command));
				return { stdout: "", stderr: "" };
			},
		});
		await service.create();
		expect(observed).toEqual([
			"kind get clusters",
			"kind create cluster --name devenv",
			"kind export kubeconfig --name devenv",
		]);
	});

	test("delete and recreate run the expected sequence", async () => {
		const observed: string[] = [];
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: async (command) => {
				observed.push(argv(command));
				return { stdout: "devenv\n", stderr: "" };
			},
		});
		await service.delete();
		expect(observed).toEqual(["kind delete cluster --name devenv"]);
		observed.length = 0;
		await service.recreate();
		expect(observed).toEqual([
			"kind delete cluster --name devenv",
			"kind get clusters",
			"kind export kubeconfig --name devenv",
		]);
	});

	test("a missing tool fails before any command runs", async () => {
		const observed: string[] = [];
		const service = new KubernetesClusterService({
			runner: new Runner({
				containerCommand: "docker",
				lookPath: (name) => (name === "kind" ? undefined : `/bin/${name}`),
			}),
			exec: async (command) => {
				observed.push(argv(command));
				return { stdout: "", stderr: "" };
			},
		});
		await expect(service.create()).rejects.toThrow(
			'missing required Kubernetes tool "kind"',
		);
		expect(observed).toEqual([]);
	});
});

describe("status watcher", () => {
	test("polls, publishes and stops on abort without collecting again", async () => {
		const controller = new AbortController();
		let collections = 0;
		const service = new KubernetesClusterService({
			runner: DOCKER,
			exec: async (command) => {
				if (argv(command) === "kind get clusters") collections++;
				return { stdout: "", stderr: "" };
			},
		});
		const published: string[] = [];
		startClusterStatusWatcher({
			service,
			signal: controller.signal,
			onStatus: (status) => published.push(status.state),
			sleep: async (_ms, signal) => {
				if (published.length >= 2) controller.abort();
				void signal;
			},
			intervalMs: 1,
		});
		await Bun.sleep(20);
		expect(published).toEqual(["missing", "missing"]);
		const before = collections;
		await Bun.sleep(20);
		expect(collections).toBe(before);
	});
});

describe("image plans (Go image_test.go fixture)", () => {
	const buildConfig = {
		repository: "repo/app",
		tag: "dev",
		pullPolicy: "IfNotPresent",
		build: { enabled: true, context: "/src", dockerfile: "/src/Dockerfile" },
		valuePaths: {
			repository: "image.repository",
			tag: "image.tag",
			pullPolicy: "image.pullPolicy",
		},
	};

	test("build command names docker or podman and qualifies short podman names", () => {
		const docker = resolveImageBuild("app", "/app", buildConfig, "docker");
		expect(argv(docker?.command ?? { name: "", args: [] })).toBe(
			"docker build -f /src/Dockerfile -t repo/app:dev /src",
		);
		const podman = resolveImageBuild("app", "/app", buildConfig, "podman");
		expect(podman?.command?.name).toBe("podman");
		const short = resolveImageBuild(
			"app",
			"/app",
			{ ...buildConfig, repository: "app" },
			"podman",
		);
		expect(short?.image).toBe("localhost/app:dev");
		expect(short?.repository).toBe("localhost/app");
	});

	test("a disabled build produces no plan", () => {
		expect(
			resolveImageBuild(
				"app",
				"/app",
				{ ...buildConfig, build: { enabled: false } },
				"docker",
			),
		).toBeUndefined();
		expect(
			resolveImageBuild("app", "/app", undefined, "docker"),
		).toBeUndefined();
	});

	test("image references default the tag and follow the runtime", () => {
		const config = {
			repository: "app",
			tag: "latest",
			pullPolicy: "IfNotPresent",
			valuePaths: { repository: "", tag: "", pullPolicy: "" },
		};
		expect(resolveImageReference("app", config, "podman")?.image).toBe(
			"localhost/app:latest",
		);
		expect(resolveImageReference("app", config, "docker")?.image).toBe(
			"app:latest",
		);
	});

	test("kind load and helm overrides", () => {
		expect(DOCKER.kindLoadImage("repo/app:dev").args).toEqual([
			"load",
			"docker-image",
			"repo/app:dev",
			"--name",
			"devenv",
		]);
		expect(isShortImageName("app")).toBe(true);
		expect(isShortImageName("repo/app")).toBe(false);
		expect(
			helmImageOverrides(buildConfig, {
				image: "repo/app:dev",
				repository: "repo/app",
				tag: "dev",
				pullPolicy: "IfNotPresent",
			}),
		).toEqual([
			"--set-string",
			"image.repository=repo/app",
			"--set-string",
			"image.tag=dev",
			"--set-string",
			"image.pullPolicy=IfNotPresent",
		]);
	});
});

describe("secrets (Go secrets_test.go fixture)", () => {
	test("a missing key fails and redaction hides every literal", () => {
		const secrets = [{ name: "env", keys: ["DB_USER", "DB_PASS"] }];
		expect(() =>
			buildSecretPlans(DOCKER, "apps", secrets, { DB_USER: "u" }),
		).toThrow('missing env key "DB_PASS" for Kubernetes Secret "env"');
		const plans = buildSecretPlans(DOCKER, "apps", secrets, {
			DB_USER: "u",
			DB_PASS: "secret",
		});
		expect(plans).toHaveLength(1);
		expect(plans[0].values.DB_PASS).toBe("secret");
		const redacted = argv(redactSecretCommand(plans[0]));
		expect(redacted).not.toContain("DB_PASS=secret");
		expect(redacted).toContain("DB_PASS=<redacted>");
		expect(argv(plans[0].command)).toContain("DB_PASS=secret");
		// Keys are sorted so two runs produce the same argv.
		expect(plans[0].keys).toEqual(["DB_PASS", "DB_USER"]);
	});
});

describe("deployment plan and status (Go status_logs_test.go fixture)", () => {
	test("helm status maps to infrastructure status", () => {
		expect(mapHelmStatus('{"info":{"status":"deployed"}}')).toBe("running");
		expect(mapHelmStatus("failed")).toBe("failed");
		expect(mapHelmStatus("pending-install")).toBe("failed");
		expect(mapHelmStatus("", new Error("missing"))).toBe("stopped");
		expect(mapHelmStatus("superseded")).toBe("stopped");
	});

	test("logs and port-forward commands target the managed context", () => {
		const logs = logsCommand(DOCKER, "api", "apps", []);
		expect(logs.args).toEqual([
			"--context",
			"kind-devenv",
			"logs",
			"--namespace",
			"apps",
			"-l",
			"app.kubernetes.io/instance=api",
			"--all-containers",
			"--tail",
			"200",
		]);
		expect(logsCommand(DOCKER, "api", "apps", ["app=api"]).args).toContain(
			"app=api",
		);
		const forward = portForwardCommand(DOCKER, "apps", {
			resource: "svc/api",
			localPort: 8080,
			remotePort: 80,
		});
		expect(forward.args).toEqual([
			"--context",
			"kind-devenv",
			"port-forward",
			"--namespace",
			"apps",
			"svc/api",
			"8080:80",
		]);
	});

	test("the deployment plan loads images, applies secrets, upgrades and waits", () => {
		const secrets = buildSecretPlans(
			DOCKER,
			"apps",
			[{ name: "env", keys: ["K"] }],
			{
				K: "v",
			},
		);
		const plan = planKubernetesDeployment({
			runner: DOCKER,
			name: "api",
			namespace: "apps",
			release: "api",
			chart: "./chart",
			values: ["./values.yaml"],
			images: ["repo/app:dev"],
			secrets,
		});
		expect(plan.commands.map(argv)).toEqual([
			"kind get clusters",
			"kind load docker-image repo/app:dev --name devenv",
			"kubectl --context kind-devenv create secret generic env --namespace apps --dry-run=client -o yaml --from-literal K=v",
			"helm --kube-context kind-devenv upgrade --install api ./chart --namespace apps --create-namespace --values ./values.yaml",
		]);
		// Readiness is a separate bound step: the plan cannot report success for
		// a deployment that never became available.
		expect(plan.readiness.map(argv)).toEqual([
			"kubectl --context kind-devenv wait --for=condition=available deployment -l app.kubernetes.io/instance=api --namespace apps --timeout 5m",
		]);
	});
});

describe("parsers", () => {
	test("version, nodes, pods and releases tolerate Go's nil handling", () => {
		expect(parseKubernetesVersion("{}")).toBe("");
		expect(parseKubernetesVersion("not json")).toBe("");
		expect(parseNodes("{}")).toEqual([]);
		expect(parsePods("{}")).toEqual({
			summary: {
				total: 0,
				running: 0,
				pending: 0,
				succeeded: 0,
				failed: 0,
				unknown: 0,
			},
			namespaces: [],
			pods: [],
		});
		expect(parseReleases("null")).toEqual([]);
		const withEmptyPhase = parsePods(
			'{"items":[{"metadata":{"name":"x","namespace":"n"}}]}',
		);
		expect(withEmptyPhase.summary.unknown).toBe(1);
		expect(withEmptyPhase.pods[0].status).toBe("Unknown");
		// Namespaces are stable-sorted; Go iterated a map.
		const sorted = parsePods(
			'{"items":[{"metadata":{"namespace":"b"}},{"metadata":{"namespace":"a"}}]}',
		);
		expect(sorted.namespaces.map((ns) => ns.name)).toEqual(["a", "b"]);
	});

	test("node stats accept docker's string and podman's numeric shapes", () => {
		const docker = parseRuntimeStatsJson(
			"devenv-node-1",
			'{"CPUPerc":"12.5%","MemUsage":"128MiB / 1GiB","MemPerc":"12.5%"}',
		);
		expect(docker).toEqual({
			name: "node-1",
			containerName: "devenv-node-1",
			cpuPercent: 12.5,
			memoryUsageBytes: 128 * 1024 * 1024,
			memoryLimitBytes: 1024 * 1024 * 1024,
			memoryPercent: 12.5,
		});
		const podman = parseRuntimeStatsJson(
			"devenv-node-1",
			'{"CPU":"5%","MemUsage":2048,"MemLimit":4096,"MemPerc":"50%"}',
		);
		expect(podman?.memoryUsageBytes).toBe(2048);
		expect(podman?.memoryLimitBytes).toBe(4096);
		expect(parseRuntimeStatsJson("n", "{}")).toBeUndefined();
		const tab = parseRuntimeStatsTab(
			"devenv-node-1",
			"7.5%\t256MiB / 2GiB\t12.5%",
		);
		expect(tab?.cpuPercent).toBe(7.5);
		expect(tab?.memoryLimitBytes).toBe(2 * 1024 * 1024 * 1024);
		expect(parseRuntimeStatsTab("n", "junk")).toBeUndefined();
	});

	test("byte and percent parsing matches Go's unit table", () => {
		expect(parseBytes("1GiB")).toBe(1024 ** 3);
		expect(parseBytes("1GB")).toBe(1e9);
		expect(parseBytes("512B")).toBe(512);
		expect(parseBytes("nonsense")).toBe(0);
		expect(parseMemoryPair("128MiB / 1GiB")).toEqual([
			128 * 1024 * 1024,
			1024 ** 3,
		]);
		expect(parseMemoryPair("128MiB")).toEqual([0, 0]);
		expect(parsePercent("12.5%")).toBe(12.5);
		expect(parsePercent("junk")).toBe(0);
	});
});
