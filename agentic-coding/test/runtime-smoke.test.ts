// Disposable-runtime smoke fixtures
// (`port-environment-runtimes-to-bun`, tasks 4.2 and 4.3).
//
// These are the only tests that touch a real runtime. They are opt-in:
//
//   DEVENV_SMOKE_RUNTIME=docker bun test test/runtime-smoke.test.ts
//   DEVENV_SMOKE_RUNTIME=kubernetes bun test test/runtime-smoke.test.ts
//
// Prerequisites are discovered once, before registration, so an unselected
// runtime or a missing one is reported by Bun as a *skipped* case with a reason
// rather than as a passing run. Once prerequisites hold, an unexpected
// create/lifecycle/observation/cleanup failure fails the test — no path returns
// a skip message after an operation was actually attempted.
//
// Every fixture creates resources carrying a run-scoped owner label and removes
// only what it created, so a user's containers, images and namespaces are never
// touched. Preservation of other owners' resources is asserted with test-owned
// separate-owner sentinels read before and after the fixture's own operation.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	containerNameMatches,
	type DockerClient,
	selectRuntime,
} from "../src/server/runtime/docker.ts";
import {
	KubernetesClusterService,
	Runner,
	spawnKubernetesExec,
} from "../src/server/runtime/kubernetes.ts";

const MODE = process.env.DEVENV_SMOKE_RUNTIME ?? "";
const OWNER_LABEL = "devenv.smoke.owner";
const RUN_ID = randomUUID().slice(0, 8);
const OWNER = `smoke-${RUN_ID}`;
const SENTINEL_OWNER = `sentinel-${RUN_ID}`;
const IMAGE = "alpine:3.20";

/** Whether a CLI exists and answers. */
function toolReady(command: string, args: readonly string[]): boolean {
	const result = spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
	return result.status === 0;
}

/** Whether an image is already present locally; the fixture never pulls one. */
function imagePresent(runtimeCommand: string, image: string): boolean {
	const result = spawnSync(runtimeCommand, ["image", "inspect", image], {
		stdio: "ignore",
		timeout: 10_000,
	});
	return result.status === 0;
}

/** A container owned by this run, created under `owner`. Throws on failure: the
 * fixture never converts an attempted operation into a skip. */
function createContainer(
	runtimeCommand: string,
	name: string,
	owner: string,
): string {
	const created = spawnSync(
		runtimeCommand,
		[
			"create",
			"--name",
			name,
			"--label",
			`${OWNER_LABEL}=${owner}`,
			IMAGE,
			"sleep",
			"120",
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	if (created.status !== 0)
		throw new Error(
			`could not create disposable container ${name}: ${created.stderr.trim() || `exit ${created.status}`}`,
		);
	const id = created.stdout.trim();
	if (!id) throw new Error(`container ${name} was created without an id`);
	return id;
}

/** Owner labels as the runtime reports them. */
function containerLabels(
	runtimeCommand: string,
	name: string,
): Record<string, string> {
	const inspected = spawnSync(
		runtimeCommand,
		["inspect", "--format", "{{json .Config.Labels}}", name],
		{ encoding: "utf8", timeout: 30_000 },
	);
	if (inspected.status !== 0)
		throw new Error(
			`could not inspect ${name}: ${inspected.stderr.trim() || `exit ${inspected.status}`}`,
		);
	const labels = JSON.parse(inspected.stdout.trim() || "{}") as Record<
		string,
		string
	>;
	return labels;
}

type Prerequisite<T> = { ok: true } & T;
type Missing = { ok: false; reason: string };

interface ContainerFixture {
	command: string;
	client: DockerClient;
}

/** Bounded preflight: everything knowable before the smoke operation runs. */
async function containerPrerequisites(): Promise<
	Prerequisite<ContainerFixture> | Missing
> {
	if (MODE !== "docker")
		return {
			ok: false,
			reason: "set DEVENV_SMOKE_RUNTIME=docker to run the container fixture",
		};
	const selection = await selectRuntime("docker");
	if (!selection)
		return { ok: false, reason: "no container runtime is reachable" };
	const command = selection.runtime.command;
	if (!imagePresent(command, IMAGE))
		return {
			ok: false,
			reason: `image ${IMAGE} is not present locally; the fixture never pulls one`,
		};
	return { ok: true, command, client: selection.client };
}

interface ClusterFixture {
	kubectl: (...args: string[]) => Promise<string>;
}

async function clusterPrerequisites(): Promise<
	Prerequisite<ClusterFixture> | Missing
> {
	if (MODE !== "kubernetes")
		return {
			ok: false,
			reason: "set DEVENV_SMOKE_RUNTIME=kubernetes to run the cluster fixture",
		};
	for (const [command, args] of [
		["kind", ["version"]],
		["kubectl", ["version", "--client"]],
	] as const) {
		if (!toolReady(command, args))
			return { ok: false, reason: `${command} is not available` };
	}
	const runner = new Runner({
		containerCommand: "docker",
		containerName: "docker",
	});
	const service = new KubernetesClusterService({
		runner,
		exec: spawnKubernetesExec(),
	});
	const status = await service.status();
	if (!status.exists || !status.reachable)
		return {
			ok: false,
			reason: `no reachable managed cluster (state ${status.state}); the fixture never creates one`,
		};
	const exec = spawnKubernetesExec();
	const kubectl = async (...args: string[]): Promise<string> => {
		const result = await exec(runner.kubectl(...args));
		if (result.error)
			throw new Error(result.stderr.trim() || result.error.message);
		return result.stdout;
	};
	return {
		ok: true,
		kubectl,
	};
}

const containers = await containerPrerequisites();
const cluster = await clusterPrerequisites();

// Bun reports these cases as skipped and the repository runner counts them
// separately from executed passes; the reason is logged for a human reader.
if (!containers.ok) console.log(`skip: ${containers.reason}`);
if (!cluster.ok) console.log(`skip: ${cluster.reason}`);

describe("container smoke fixture (task 4.2)", () => {
	test.skipIf(!containers.ok)(
		"lifecycle, logs and owned removal against a disposable container",
		async () => {
			if (!containers.ok)
				throw new Error(`prerequisites unavailable: ${containers.reason}`);
			const { client, command } = containers;
			const name = `devenv-smoke-${RUN_ID}`;
			const target = { ident: name, containerBaseName: name };
			const containerId = createContainer(command, name, OWNER);
			try {
				await client.startContainer(containerId);
				expect((await client.getInfo(target)).Status).toBe("running");
				// The name matcher resolves the runtime's own naming.
				expect(containerNameMatches(`/${name}`, name, name)).toBe(true);

				await client.stopContainer(containerId);
				expect((await client.getInfo(target)).Status).toBe("exited");
				await client.startContainer(containerId);
				await client.restartContainer(containerId);
				expect((await client.getInfo(target)).Status).toBe("running");

				// Logs are readable and framed.
				expect(typeof (await client.getContainerLogs(containerId))).toBe(
					"string",
				);

				// Readiness: a container without a healthcheck is ready once running.
				await client.waitForHealthy(
					containerId,
					10_000,
					undefined,
					undefined,
					200,
				);
			} finally {
				// Owned cleanup: the id came from this run's create call.
				await client.killAndRemoveContainer(containerId);
			}
			expect((await client.getInfo(target)).Status).toBe("not found");
		},
		120_000,
	);

	test.skipIf(!containers.ok)(
		"a separate owner's container keeps its identity and state",
		async () => {
			if (!containers.ok)
				throw new Error(`prerequisites unavailable: ${containers.reason}`);
			const { client, command } = containers;
			const sentinelName = `devenv-smoke-sentinel-${RUN_ID}`;
			const ownedName = `devenv-smoke-${RUN_ID}`;
			const sentinelTarget = {
				ident: sentinelName,
				containerBaseName: sentinelName,
			};
			const ownedTarget = { ident: ownedName, containerBaseName: ownedName };
			const sentinelId = createContainer(command, sentinelName, SENTINEL_OWNER);
			const readSentinel = async () => ({
				...(await client.getInfo(sentinelTarget)),
				labels: containerLabels(command, sentinelName),
			});
			try {
				const before = await readSentinel();
				expect(before.ContainerID).toBe(sentinelId);
				expect(before.labels[OWNER_LABEL]).toBe(SENTINEL_OWNER);
				// A different owner's container is never selected by this run's name.
				expect(
					containerNameMatches(`/${sentinelName}`, ownedName, ownedName),
				).toBe(false);

				// The fixture's own create/remove path, on a container it owns.
				const ownedId = createContainer(command, ownedName, OWNER);
				await client.startContainer(ownedId);
				expect((await client.getInfo(ownedTarget)).Status).toBe("running");
				await client.killAndRemoveContainer(ownedId);
				expect((await client.getInfo(ownedTarget)).Status).toBe("not found");

				// Identity, state and labels of the separate owner's container are
				// unchanged by the removal above.
				expect(await readSentinel()).toEqual(before);
			} finally {
				// Teardown removes only the sentinel this fixture created.
				await client.killAndRemoveContainer(sentinelId);
			}
		},
		120_000,
	);
});

describe("Kubernetes smoke fixture (task 4.3)", () => {
	test.skipIf(!cluster.ok)(
		"a disposable namespace is created, observed and removed",
		async () => {
			if (!cluster.ok)
				throw new Error(`prerequisites unavailable: ${cluster.reason}`);
			const { kubectl } = cluster;
			const namespace = `devenv-smoke-${RUN_ID}`;
			try {
				await kubectl(
					"create",
					"namespace",
					namespace,
					"--dry-run=client",
					"-o",
					"yaml",
				);
				await kubectl("create", "namespace", namespace);
				await kubectl(
					"label",
					"namespace",
					namespace,
					`${OWNER_LABEL}=${OWNER}`,
				);
				// A config map is the smallest owned resource to observe.
				await kubectl(
					"create",
					"configmap",
					`${namespace}-probe`,
					"--namespace",
					namespace,
					"--from-literal",
					"probe=ok",
				);
				const namespaces = await kubectl(
					"get",
					"namespace",
					namespace,
					"-o",
					"name",
				);
				expect(namespaces.trim()).toBe(`namespace/${namespace}`);
				const releases = await kubectl(
					"get",
					"configmap",
					"--namespace",
					namespace,
					"-o",
					"name",
				);
				expect(releases.trim()).toBe(`configmap/${namespace}-probe`);
			} finally {
				// Only the namespace this run created is deleted.
				await kubectl("delete", "namespace", namespace, "--ignore-not-found");
			}
		},
		180_000,
	);

	test.skipIf(!cluster.ok)(
		"a separate owner's namespace keeps its identity and labels",
		async () => {
			if (!cluster.ok)
				throw new Error(`prerequisites unavailable: ${cluster.reason}`);
			const { kubectl } = cluster;
			const sentinel = `devenv-smoke-sentinel-${RUN_ID}`;
			const owned = `devenv-smoke-${RUN_ID}`;
			const readSentinel = async (): Promise<string> => {
				const raw = await kubectl("get", "namespace", sentinel, "-o", "json");
				const parsed = JSON.parse(raw) as {
					metadata: { uid: string; labels?: Record<string, string> };
					status?: { phase?: string };
				};
				return `${parsed.metadata.uid}|${parsed.metadata.labels?.[OWNER_LABEL] ?? ""}|${parsed.status?.phase ?? ""}`;
			};
			await kubectl("create", "namespace", sentinel);
			await kubectl(
				"label",
				"namespace",
				sentinel,
				`${OWNER_LABEL}=${SENTINEL_OWNER}`,
			);
			try {
				const before = await readSentinel();
				expect(before).toContain(`|${SENTINEL_OWNER}|`);

				// The fixture's own namespace create/observe/remove path.
				await kubectl("create", "namespace", owned);
				await kubectl("label", "namespace", owned, `${OWNER_LABEL}=${OWNER}`);
				expect(
					(await kubectl("get", "namespace", owned, "-o", "name")).trim(),
				).toBe(`namespace/${owned}`);
				await kubectl("delete", "namespace", owned, "--wait=false");

				// The separate owner's namespace keeps its uid, labels and phase.
				expect(await readSentinel()).toBe(before);
			} finally {
				// Teardown removes only the sentinel this fixture created.
				await kubectl(
					"delete",
					"namespace",
					sentinel,
					"--ignore-not-found",
					"--wait=false",
				);
			}
		},
		180_000,
	);
});
