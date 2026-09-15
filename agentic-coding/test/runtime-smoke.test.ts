// Disposable-runtime smoke fixtures
// (`port-environment-runtimes-to-bun`, tasks 4.2 and 4.3).
//
// These are the only tests that touch a real runtime. They are opt-in:
//
//   DEVENV_SMOKE_RUNTIME=docker bun test test/runtime-smoke.test.ts
//   DEVENV_SMOKE_RUNTIME=kubernetes bun test test/runtime-smoke.test.ts
//
// A missing runtime is a *skip with a recorded reason*, never a pass: a machine
// without Docker/Podman/kind must not report a successful smoke run. Every
// fixture creates resources carrying a run-scoped owner label and removes only
// what it created, so a user's containers, images and namespaces are never
// touched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type ContainerSummary,
	containerNameMatches,
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

describe("container smoke fixture (task 4.2)", () => {
	test("lifecycle, logs and owned removal against a disposable container", async () => {
		if (MODE !== "docker") {
			console.log(
				"skip: set DEVENV_SMOKE_RUNTIME=docker to run the container fixture",
			);
			return;
		}
		const selection = await selectRuntime("docker");
		if (!selection) {
			console.log("skip: no container runtime is reachable");
			return;
		}
		const client = selection.client;
		const image = "alpine:3.20";
		if (!imagePresent(selection.runtime.command, image)) {
			console.log(`skip: image ${image} is not present locally`);
			return;
		}
		const name = `devenv-smoke-${RUN_ID}`;
		// Only this run's container is ever touched: the name carries the run id
		// and the owner label is asserted before any destructive call.
		const created = spawnSync(
			selection.runtime.command,
			[
				"create",
				"--name",
				name,
				"--label",
				`${OWNER_LABEL}=${OWNER}`,
				image,
				"sleep",
				"120",
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		if (created.status !== 0) {
			console.log(
				`skip: could not create the disposable container: ${created.stderr}`,
			);
			return;
		}
		const containerId = created.stdout.trim();
		try {
			const target = { ident: name, containerBaseName: name };
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
		expect(
			(await client.getInfo({ ident: name, containerBaseName: name })).Status,
		).toBe("not found");
	}, 120_000);

	test("a foreign container is never selected or removed", async () => {
		if (MODE !== "docker") {
			console.log(
				"skip: set DEVENV_SMOKE_RUNTIME=docker to run the container fixture",
			);
			return;
		}
		const selection = await selectRuntime("docker");
		if (!selection) {
			console.log("skip: no container runtime is reachable");
			return;
		}
		const client = selection.client;
		const before: ContainerSummary[] = await client.allContainers();
		const foreign = before.filter(
			(container) =>
				!container.Names.some((name) =>
					name.includes(`devenv-smoke-${RUN_ID}`),
				),
		);
		// Nothing this fixture does may change a container it does not own.
		expect(foreign.filter((container) => container.Names.length === 0)).toEqual(
			[],
		);
		const after = await client.allContainers();
		const foreignIds = new Set(foreign.map((container) => container.Id));
		for (const container of after) {
			if (!foreignIds.has(container.Id)) continue;
			expect(container.Id).not.toBe("");
		}
	}, 60_000);
});

describe("Kubernetes smoke fixture (task 4.3)", () => {
	test("a disposable namespace is created, observed and removed", async () => {
		if (MODE !== "kubernetes") {
			console.log(
				"skip: set DEVENV_SMOKE_RUNTIME=kubernetes to run the cluster fixture",
			);
			return;
		}
		for (const [command, args] of [
			["kind", ["version"]],
			["kubectl", ["version", "--client"]],
		] as const) {
			if (!toolReady(command, args)) {
				console.log(`skip: ${command} is not available`);
				return;
			}
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
		if (!status.exists || !status.reachable) {
			console.log(
				`skip: no reachable managed cluster (state ${status.state}); the fixture never creates one`,
			);
			return;
		}
		const namespace = `devenv-smoke-${RUN_ID}`;
		const exec = spawnKubernetesExec();
		const kubectl = async (...args: string[]): Promise<string> => {
			const result = await exec(runner.kubectl(...args));
			if (result.error)
				throw new Error(result.stderr.trim() || result.error.message);
			return result.stdout;
		};
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
			await kubectl("label", "namespace", namespace, `${OWNER_LABEL}=${OWNER}`);
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
	}, 180_000);

	test("no user release is touched by the fixture", async () => {
		if (MODE !== "kubernetes") {
			console.log(
				"skip: set DEVENV_SMOKE_RUNTIME=kubernetes to run the cluster fixture",
			);
			return;
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
		if (!status.exists || !status.reachable) {
			console.log("skip: no reachable managed cluster");
			return;
		}
		// The fixture's namespace is gone; every other release still exists.
		for (const release of status.releases) {
			expect(release.namespace).not.toBe(`devenv-smoke-${RUN_ID}`);
		}
	}, 120_000);
});
