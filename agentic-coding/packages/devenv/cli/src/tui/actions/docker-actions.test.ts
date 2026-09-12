import { describe, expect, test } from "bun:test";
import { createDockerActions, operationProgressLabel } from "./docker-actions";

type DockerActionStore = Parameters<typeof createDockerActions>[0];
type DockerActionUiStore = Parameters<typeof createDockerActions>[1];
type DockerActionClient = Parameters<typeof createDockerActions>[2];

test("operation progress labels use correct doubled consonants", () => {
	expect(
		["start", "stop", "restart", "build", "test", "run"].map((action) =>
			operationProgressLabel(
				action as Parameters<typeof operationProgressLabel>[0],
			),
		),
	).toEqual([
		"Starting",
		"Stopping",
		"Restarting",
		"Building",
		"Testing",
		"Running",
	]);
});

function createStores(
	app: unknown,
	kubernetesClusterStatus?: { provider: string },
) {
	let apps = [app];
	let operationInProgressForApp: string | null = null;
	const appStore = {
		filteredApps: () => apps,
		selectedIndex: () => 0,
		operationInProgressForApp: () => operationInProgressForApp,
		setOperationInProgressForApp: (ident: string | null) => {
			operationInProgressForApp = ident;
		},
		setError: () => {},
		pushModal: () => {},
		apps: () => apps,
		setApps: (next: unknown[] | ((prev: unknown[]) => unknown[])) => {
			apps = typeof next === "function" ? next(apps) : next;
		},
		infraServices: () => [],
		setInfraServices: () => {},
		kubernetesClusterStatus: () => kubernetesClusterStatus,
	};
	const uiStore = {
		setNotification: () => {},
		setActionTargetPickerTargets: (_next: unknown[]) => {},
		setActionTargetPickerSelectedIndex: () => {},
		setActionTargetPickerAppIdent: () => {},
		setActionTargetPickerAction: () => {},
		setShowActionTargetPicker: (_next: boolean) => {},
		setLoadingModalMessage: () => {},
		setShowLoadingModal: () => {},
	};
	return { appStore, uiStore };
}

describe("docker actions", () => {
	test("selected build starts backend action id", async () => {
		const app = { ident: "web", displayName: "Web" };
		const target = {
			id: "app/web/build/docker/with-redis",
			action: "build",
			runtime: "docker",
			label: "with-redis",
			profile: "with-redis",
		};
		const { appStore, uiStore } = createStores(app);
		const calls: unknown[][] = [];
		const client = {
			startActionRun: async (...args: unknown[]) => {
				calls.push(args);
			},
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.runSelectedTarget(
			app as unknown as Parameters<typeof actions.runSelectedTarget>[0],
			"build",
			target as unknown as Parameters<typeof actions.runSelectedTarget>[2],
		);

		expect(calls).toEqual([["app/web/build/docker/with-redis"]]);
	});

	test("infrastructure start uses backend definitions and only picks among multiple actions", async () => {
		const { appStore, uiStore } = createStores({ ident: "app" });
		let targets: unknown[] = [];
		let shown = false;
		uiStore.setActionTargetPickerTargets = (next: unknown[]) => {
			targets = next;
		};
		uiStore.setShowActionTargetPicker = (next: boolean) => {
			shown = next;
		};
		const starts: string[] = [];
		const client = {
			getActionDefinitions: async (ident: string) => ({
				version: 1,
				actions:
					ident === "redis"
						? [
								{
									id: "infra/redis/action/start/docker/default",
									type: "start",
									runtime: "docker",
									label: "Default",
									availability: { available: true },
									root: {},
								},
							]
						: [
								{
									id: "infra/clock/action/start/shell/default",
									type: "start",
									runtime: "shell",
									label: "Shell",
									availability: { available: true },
									root: {},
								},
								{
									id: "infra/clock/action/start/powershell/default",
									type: "start",
									runtime: "powershell",
									label: "PowerShell",
									availability: { available: true },
									root: {},
								},
							],
			}),
			startActionRun: async (id: string) => {
				starts.push(id);
			},
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.openInfrastructureStartTargetPicker({
			ident: "redis",
			displayName: "Redis",
			type: "docker",
			containerBaseName: "redis",
		} as unknown as Parameters<
			typeof actions.openInfrastructureStartTargetPicker
		>[0]);
		expect(starts).toEqual(["infra/redis/action/start/docker/default"]);
		expect(shown).toBe(false);

		await actions.openInfrastructureStartTargetPicker({
			ident: "clock",
			displayName: "Clock",
			type: "script",
			shellPath: "clock.sh",
			powerShellPath: "clock.ps1",
		} as unknown as Parameters<
			typeof actions.openInfrastructureStartTargetPicker
		>[0]);
		expect(targets).toEqual([
			expect.objectContaining({
				id: "infra/clock/action/start/shell/default",
				label: "Shell",
			}),
			expect.objectContaining({
				id: "infra/clock/action/start/powershell/default",
				label: "PowerShell",
			}),
		]);
		expect(shown).toBe(true);
	});

	test("Kubernetes cluster actions use cluster provider", async () => {
		const { appStore, uiStore } = createStores({ ident: "web" });
		const calls: string[] = [];
		const client = {
			getActionDefinitions: async () => ({
				version: 1,
				actions: [
					{
						id: "kubernetes/local/action/create/docker/default",
						type: "create",
						runtime: "docker",
						availability: { available: true },
					},
					{
						id: "kubernetes/local/action/create/podman/default",
						type: "create",
						runtime: "podman",
						availability: { available: true },
					},
				],
			}),
			startActionRun: async (id: string) => {
				calls.push(id);
			},
			getKubernetesClusterStatus: async () => ({
				exists: true,
				provider: "podman",
			}),
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.createCluster();

		expect(calls).toEqual(["kubernetes/local/action/create/podman/default"]);
	});

	test("app stop starts matching backend stop action", async () => {
		const app = {
			ident: "web",
			displayName: "Web",
			runTargetInfo: {
				targetId: "app/web/run/docker/redis",
				runtime: "docker",
				profile: "redis",
			},
		};
		const { appStore, uiStore } = createStores(app);
		const calls: string[] = [];
		const client = {
			getActionDefinitions: async () => ({
				version: 1,
				actions: [
					{
						id: "app/web/action/stop/docker/redis",
						type: "stop",
						runtime: "docker",
						label: "Stop",
						availability: { available: true },
						root: {},
					},
				],
			}),
			startActionRun: async (id: string) => {
				calls.push(id);
			},
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.performDockerOperation(
			"stop",
			app as unknown as Parameters<typeof actions.performDockerOperation>[1],
		);

		expect(calls).toEqual(["app/web/action/stop/docker/redis"]);
	});

	test("app stop uses Podman lifecycle for a Podman run target", async () => {
		const app = {
			ident: "web",
			displayName: "Web",
			runTargetInfo: {
				targetId: "app/web/run/podman/with-redis",
				runtime: "podman",
				profile: "with-redis",
			},
		};
		const { appStore, uiStore } = createStores(app);
		const calls: string[] = [];
		const client = {
			getActionDefinitions: async () => ({
				version: 1,
				actions: [
					{
						id: "app/web/action/stop/docker/with-redis",
						type: "stop",
						runtime: "docker",
						label: "Stop (docker)",
						availability: { available: true },
						root: {},
					},
					{
						id: "app/web/action/stop/podman/with-redis",
						type: "stop",
						runtime: "podman",
						label: "Stop (podman)",
						availability: { available: true },
						root: {},
					},
				],
			}),
			startActionRun: async (id: string) => {
				calls.push(id);
			},
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.performDockerOperation(
			"stop",
			app as unknown as Parameters<typeof actions.performDockerOperation>[1],
		);

		expect(calls).toEqual(["app/web/action/stop/podman/with-redis"]);
	});

	test("app stop chooses Kubernetes lifecycle over stale Podman run target when pods run", async () => {
		const app = {
			ident: "web",
			displayName: "Web",
			status: "running (1/1 pods)",
			runTargetInfo: {
				targetId: "app/web/run/docker/with-redis",
				runtime: "podman",
				profile: "with-redis",
			},
		};
		const { appStore, uiStore } = createStores(app);
		const calls: string[] = [];
		const client = {
			getActionDefinitions: async () => ({
				version: 1,
				actions: [
					{
						id: "app/web/action/stop/podman/with-redis",
						type: "stop",
						runtime: "podman",
						label: "Stop (podman)",
						availability: { available: true },
						root: {},
					},
					{
						id: "app/web/action/stop/kubernetes/k8s-local",
						type: "stop",
						runtime: "kubernetes",
						label: "Stop",
						availability: { available: true },
						root: {},
					},
				],
			}),
			startActionRun: async (id: string) => {
				calls.push(id);
			},
		};
		const actions = createDockerActions(
			appStore as unknown as DockerActionStore,
			uiStore as unknown as DockerActionUiStore,
			client as unknown as DockerActionClient,
			() => {},
		);

		await actions.performDockerOperation(
			"stop",
			app as unknown as Parameters<typeof actions.performDockerOperation>[1],
		);

		expect(calls).toEqual(["app/web/action/stop/kubernetes/k8s-local"]);
	});
});
