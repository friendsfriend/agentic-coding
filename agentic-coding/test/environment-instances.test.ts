import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerApp } from "../src/server/app.ts";
import { createInstanceAuthority } from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import {
	environmentInstanceId,
	environmentInstanceStorageId,
	parseEnvironmentOwner,
} from "../src/server/environment/instances/model.ts";
import {
	EnvironmentPortAllocator,
	PortUnavailableError,
	scanPortNames,
} from "../src/server/environment/instances/ports.ts";
import { resolveInstanceVariables } from "../src/server/environment/instances/variables.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import { EventBroker } from "../src/server/events.ts";
import {
	DockerClient,
	type DockerRuntime,
} from "../src/server/runtime/docker.ts";
import { EnvironmentInstanceController } from "../src/server/runtime/instances.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

function tempState(): {
	dir: string;
	store: EnvironmentStateStore;
	cleanup(): void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "environment-instances-"));
	const store = EnvironmentStateStore.open(dir);
	return {
		dir,
		store,
		cleanup: () => {
			store.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

function app(localDirectoryPath: string, ident = "shop") {
	return {
		ident,
		displayName: ident,
		repositoryPath: "https://example.com/shop",
		appType: "app",
		localDirectoryPath,
		branch: "main",
	};
}

function composeFixture(
	root: string,
	source = `services:\n  web:\n    image: "shop:\${AC_IMAGE_TAG:-latest}"\n    ports:\n      - "\${AC_PORT_HTTP:-8080}:80"\n`,
) {
	const configDir = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
	fs.mkdirSync(checkout, { recursive: true });
	const sourcePath = path.join(
		configDir,
		"apps",
		"compose",
		"shop-compose.yml",
	);
	fs.writeFileSync(sourcePath, source);
	return { configDir, checkout, sourcePath };
}

describe("environment instance identity and variables", () => {
	test("parses owners and makes stable sanitized app-scoped workflow ids", () => {
		expect(parseEnvironmentOwner("user")).toBe("user");
		expect(parseEnvironmentOwner("workflow:abc/feature branch")).toBe(
			"workflow:abc/feature branch",
		);
		const id = environmentInstanceId("workflow:abc/feature branch", "shop");
		expect(id).toBe(
			environmentInstanceId("workflow:abc/feature branch", "shop"),
		);
		expect(id).toMatch(/^[a-z0-9-]{1,24}$/);
		expect(
			environmentInstanceId("workflow:abc/feature branch", "store"),
		).not.toBe(id);
		expect(environmentInstanceId("workflow:a", "shop")).not.toBe(
			environmentInstanceId("workflow:b", "shop"),
		);
		expect(environmentInstanceId("user", "shop")).toBe("default");
		expect(environmentInstanceStorageId("user", "shop")).not.toBe(
			environmentInstanceStorageId("user", "store"),
		);
		expect(() => parseEnvironmentOwner("workflow:")).toThrow(/owner/);
		expect(() => parseEnvironmentOwner("team:abc")).toThrow(/owner/);
		expect(() => parseEnvironmentOwner("workflow:unsafe\u0000id")).toThrow(
			/control characters/,
		);
		expect(() => environmentInstanceId("user", "bad\u0000app")).toThrow(
			/control characters/,
		);
	});

	test("resolves user defaults and workflow-specific variables", () => {
		expect(
			resolveInstanceVariables({
				instanceId: "default",
				owner: "user",
				appDir: "/apps/shop",
			}),
		).toEqual({
			AC_INSTANCE: "default",
			AC_OWNER: "user",
			AC_APP_DIR: "/apps/shop",
			AC_IMAGE_TAG: "latest",
		});
		expect(
			resolveInstanceVariables({
				instanceId: "workflow-shop",
				owner: "workflow:abc",
				appDir: "/worktrees/abc/shop",
				ports: { HTTP: 22000 },
			}),
		).toEqual({
			AC_INSTANCE: "workflow-shop",
			AC_OWNER: "workflow:abc",
			AC_APP_DIR: "/worktrees/abc/shop",
			AC_IMAGE_TAG: "workflow-shop",
			AC_PORT_HTTP: "22000",
		});
	});
});

class MemoryPortStore {
	allocations = new Map<
		string,
		{ instanceId: string; name: string; port: number }
	>();
	getPortAllocations(instanceId?: string) {
		return [...this.allocations.values()].filter(
			(item) => instanceId === undefined || item.instanceId === instanceId,
		);
	}
	setPortAllocation(item: {
		instanceId: string;
		name: string;
		port: number;
	}): boolean {
		if (
			[...this.allocations.values()].some(
				(current) =>
					current.port === item.port && current.instanceId !== item.instanceId,
			)
		)
			return false;
		this.allocations.set(`${item.instanceId}:${item.name}`, item);
		return true;
	}
	deletePortAllocations(instanceId: string): void {
		for (const [key, item] of this.allocations)
			if (item.instanceId === instanceId) this.allocations.delete(key);
	}
}

describe("environment instance port allocation", () => {
	test("discovers, allocates, reuses, frees, and leaves user ports untouched", async () => {
		const store = new MemoryPortStore();
		const allocator = new EnvironmentPortAllocator({
			store,
			isBindable: async () => true,
		});
		const source = `ports: ["\${AC_PORT_HTTP:-8080}:80", "\${AC_PORT_METRICS:-9090}:9090"]`;
		expect(scanPortNames(source)).toEqual(["HTTP", "METRICS"]);
		const first = await allocator.allocate({
			instanceId: "one",
			owner: "workflow:a",
			source,
			range: { start: 22000, end: 22001 },
		});
		expect(first).toEqual({ HTTP: 22000, METRICS: 22001 });
		expect(
			await allocator.allocate({
				instanceId: "one",
				owner: "workflow:a",
				source,
				range: { start: 22000, end: 22001 },
			}),
		).toEqual(first);
		expect(
			await allocator.allocate({
				instanceId: "user-shop",
				owner: "user",
				source,
				range: { start: 22000, end: 22001 },
			}),
		).toEqual({});
		await expect(
			allocator.allocate({
				instanceId: "two",
				owner: "workflow:b",
				source: `\${AC_PORT_HTTP:-80}`,
				range: { start: 22000, end: 22001 },
			}),
		).rejects.toBeInstanceOf(PortUnavailableError);
		allocator.free("one");
		expect(
			await allocator.allocate({
				instanceId: "two",
				owner: "workflow:b",
				source: `\${AC_PORT_HTTP:-80}`,
				range: { start: 22000, end: 22001 },
			}),
		).toEqual({ HTTP: 22000 });
	});
});

describe("environment instance controller", () => {
	test("starts a per-owner compose project with variables and returns already-running", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-controller-"));
		const fixture = composeFixture(root);
		fs.mkdirSync(path.join(fixture.configDir, "apps", "run"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "run", "shop-default.sh"),
			"#!/bin/sh\n",
		);
		const state = tempState();
		const calls: {
			command: string;
			args: readonly string[];
			env: Readonly<Record<string, string>>;
		}[] = [];
		const docker = {
			runtime: RUNTIME,
			client: new DockerClient(RUNTIME, {
				fetch: (async () => Response.json([])) as unknown as typeof fetch,
			}),
			fallbacks: [],
		};
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker,
			resolveOwnerCheckout: (_owner, value) =>
				path.join(fixture.checkout, value.ident),
			portRange: () => "23000-23010",
			isPortBindable: async () => true,
			runCommand: async (command, args, options) => {
				calls.push({ command, args, env: options.env });
				return { exitCode: 0, output: "" };
			},
		});
		const originalWorkflowToken = process.env.AGENTIC_WORKFLOW_TOKEN;
		const originalAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
		const originalDockerHost = process.env.DOCKER_HOST;
		process.env.AGENTIC_WORKFLOW_TOKEN = "must-not-reach-instance";
		process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-instance";
		process.env.DOCKER_HOST = "unix:///tmp/docker.sock";
		try {
			const started = await controller.start({
				owner: "workflow:run-a",
				app: "shop",
			});
			expect(started.outcome).toBe("started");
			const instanceId = started.instance.id;
			expect(instanceId).toMatch(/^[a-z0-9-]{1,24}$/);
			expect(started.instance).toMatchObject({
				id: instanceId,
				owner: "workflow:run-a",
				status: "running",
				imageTag: instanceId,
				endpoints: {
					HTTP: expect.stringMatching(/^http:\/\/127\.0\.0\.1:23\d{3}$/),
				},
			});
			expect(calls[0]?.command).toBe("docker-compose");
			expect(calls[0]?.args?.[0]).toBe("-p");
			expect(calls[0]?.args?.[1]).toBe(`shop-${instanceId}`);
			expect(calls[0]?.args?.slice(2)).toEqual([
				"-f",
				fixture.sourcePath,
				"up",
				"-d",
			]);
			expect(calls[0]?.env.AC_OWNER).toBe("workflow:run-a");
			expect(calls[0]?.env.AGENTIC_WORKFLOW_TOKEN).toBeUndefined();
			expect(calls[0]?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
			expect(calls[0]?.env.DOCKER_HOST).toBe("unix:///tmp/docker.sock");
			expect(calls[0]?.env.AC_APP_DIR).toBe(
				path.join(fixture.checkout, "shop"),
			);
			expect(calls[0]?.env.AC_PORT_HTTP).toBe("23000");
			const second = await controller.start({
				owner: "workflow:run-b",
				app: "shop",
			});
			expect(second.instance.id).not.toBe(instanceId);
			expect(second.instance.imageTag).not.toBe(started.instance.imageTag);
			expect(calls[1]?.args?.[1]).toBe(`shop-${second.instance.id}`);
			expect(calls[1]?.env.AC_PORT_HTTP).toBe("23001");
			expect(
				(await controller.start({ owner: "workflow:run-a", app: "shop" }))
					.outcome,
			).toBe("already-running");
			expect(calls).toHaveLength(2);
			const stopped = await controller.stop(instanceId, "shop");
			expect(stopped.status).toBe("stopped");
			expect(calls[2]?.args).toEqual([
				"-p",
				`shop-${instanceId}`,
				"-f",
				fixture.sourcePath,
				"down",
			]);
			expect(state.store.getPortAllocations()).toHaveLength(1);
			await controller.stop(second.instance.id, "shop");
			expect(state.store.getPortAllocations()).toHaveLength(0);
		} finally {
			if (originalWorkflowToken === undefined)
				delete process.env.AGENTIC_WORKFLOW_TOKEN;
			else process.env.AGENTIC_WORKFLOW_TOKEN = originalWorkflowToken;
			if (originalAwsSecret === undefined)
				delete process.env.AWS_SECRET_ACCESS_KEY;
			else process.env.AWS_SECRET_ACCESS_KEY = originalAwsSecret;
			if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = originalDockerHost;
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("shares one in-flight Docker probe across concurrent owner starts", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-runtime-probe-"),
		);
		const fixture = composeFixture(root);
		const state = tempState();
		let probeCount = 0;
		const args: string[][] = [];
		const docker = {
			runtime: RUNTIME,
			client: new DockerClient(RUNTIME, {
				fetch: (async () => Response.json([])) as unknown as typeof fetch,
			}),
			fallbacks: [],
		};
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveDocker: async () => {
				probeCount++;
				await Bun.sleep(5);
				return docker;
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23200-23210",
			isPortBindable: async () => true,
			runCommand: async (_command, commandArgs) => {
				args.push([...commandArgs]);
				return { exitCode: 0, output: "" };
			},
		});
		try {
			const [first, second] = await Promise.all([
				controller.start({ owner: "workflow:probe-a", app: "shop" }),
				controller.start({ owner: "workflow:probe-b", app: "shop" }),
			]);
			expect(probeCount).toBe(1);
			expect(first.instance.id).not.toBe(second.instance.id);
			expect(args.map((entry) => entry[1]).sort()).toEqual(
				[`shop-${first.instance.id}`, `shop-${second.instance.id}`].sort(),
			);
			expect(args.map((entry) => entry.includes("up"))).toEqual([true, true]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("stop refuses an in-flight start without overwriting its status or reservations", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-start-stop-race-"),
		);
		const fixture = composeFixture(root);
		const state = tempState();
		let enteredStart: (() => void) | undefined;
		let releaseStart: (() => void) | undefined;
		const startEntered = new Promise<void>((resolve) => {
			enteredStart = resolve;
		});
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23300-23310",
			isPortBindable: async () => true,
			runCommand: async (_command, commandArgs) => {
				if (commandArgs.includes("up")) {
					enteredStart?.();
					await startGate;
				}
				return { exitCode: 0, output: "" };
			},
		});
		try {
			const starting = controller.start({
				owner: "workflow:race",
				app: "shop",
			});
			await startEntered;
			const id = environmentInstanceId("workflow:race", "shop");
			await expect(controller.stop(id, "shop")).rejects.toMatchObject({
				code: "instance-busy",
			});
			if (!releaseStart)
				throw new Error("Compose start gate was not initialized");
			releaseStart();
			const result = await starting;
			expect(result.instance.status).toBe("running");
			expect(state.store.getPortAllocations()).toHaveLength(1);
			const stopped = await controller.stop(id, "shop");
			expect(stopped.status).toBe("stopped");
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("continues using a stored app-scoped durable instance key", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-legacy-key-"));
		const fixture = composeFixture(root);
		const state = tempState();
		state.store.setEnvironmentInstance({
			id: "legacy-key",
			owner: "workflow:legacy-owner",
			app: "shop",
			targetId: "app/shop/run/docker/default",
			runtime: "docker",
			checkoutPath: fixture.checkout,
			imageTag: "legacy-key",
			status: "stopped",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		});
		const args: string[][] = [];
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23400-23410",
			isPortBindable: async () => true,
			runCommand: async (_command, commandArgs) => {
				args.push([...commandArgs]);
				return { exitCode: 0, output: "" };
			},
		});
		try {
			const started = await controller.start({
				owner: "workflow:legacy-owner",
				app: "shop",
			});
			expect(started.instance.id).toBe("legacy-key");
			expect(args[0]?.[1]).toBe("shop-legacy-key");
			expect(state.store.getEnvironmentInstance("legacy-key")?.status).toBe(
				"running",
			);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("retries once with a different allocated port after a Compose bind conflict", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-port-retry-"));
		const fixture = composeFixture(root);
		const state = tempState();
		const attempted: string[] = [];
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23500-23501",
			isPortBindable: async () => true,
			runCommand: async (_command, _args, options) => {
				attempted.push(options.env.AC_PORT_HTTP ?? "");
				return attempted.length === 1
					? { exitCode: 1, output: "port is already allocated" }
					: { exitCode: 0, output: "" };
			},
		});
		try {
			const result = await controller.start({
				owner: "workflow:retry",
				app: "shop",
			});
			expect(attempted).toEqual(["23500", "23501"]);
			expect(result.instance.endpoints.HTTP).toBe("http://127.0.0.1:23501");
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses a shell target when Docker is unavailable and passes instance variables", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-script-"));
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		fs.mkdirSync(path.join(fixture.configDir, "apps", "run"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "run", "shop-default.sh"),
			`#!/bin/sh\nprintf '%s' "\${AC_PORT_HTTP:-8080}"\n`,
		);
		const state = tempState();
		const launches: Array<{
			ident: string;
			env?: Readonly<Record<string, string>>;
			forceLogged?: boolean;
		}> = [];
		const stops: string[] = [];
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23000-23010",
			isPortBindable: async () => true,
			scriptInfra: {
				launch: async (input) => {
					launches.push({
						ident: input.ident,
						env: input.env,
						forceLogged: input.forceLogged,
					});
					return { status: "running", logPath: "" };
				},
				status: async () => ({ status: "running", logPath: "" }),
				stop: async (ident) => {
					stops.push(ident);
				},
				executionHandle: (ident) =>
					launches.some((launch) => launch.ident === ident)
						? { mode: "logged", runner: "shell", startedAt: "now" }
						: undefined,
			},
		});
		try {
			const result = await controller.start({
				owner: "workflow:script-run",
				app: "shop",
			});
			expect(result.instance.runtime).toBe("shell");
			expect(launches).toHaveLength(1);
			expect(launches[0]?.ident).toContain("environment-instance:");
			expect(launches[0]?.forceLogged).toBe(true);
			expect(launches[0]?.env).toMatchObject({
				AC_OWNER: "workflow:script-run",
				AC_APP_DIR: fixture.checkout,
			});
			expect(state.store.getPortAllocations()).toHaveLength(1);
			const stopped = await controller.stop(result.instance.id, "shop");
			expect(stopped.status).toBe("stopped");
			expect(stops).toEqual([launches[0]?.ident]);
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("script instance observation frees reservations after an observed exit", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-script-exit-"),
		);
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		fs.mkdirSync(path.join(fixture.configDir, "apps", "run"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "run", "shop-default.sh"),
			`echo "\${AC_PORT_HTTP:-8080}"\n`,
		);
		const state = tempState();
		const handle = { mode: "logged", runner: "shell", startedAt: "now" };
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23150-23160",
			isPortBindable: async () => true,
			scriptInfra: {
				launch: async () => ({ status: "running", logPath: "" }),
				status: async () => ({ status: "running", logPath: "" }),
				observe: async () => ({ status: "stopped", logPath: "" }),
				stop: async () => {},
				executionHandle: () => handle,
			},
		});
		try {
			const started = await controller.start({
				owner: "workflow:exit-observed",
				app: "shop",
			});
			expect(state.store.getPortAllocations()).toHaveLength(1);
			const current = await controller.get(started.instance.id, "shop");
			expect(current.status).toBe("stopped");
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("retains script reservations when its process handle is unavailable", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-script-untracked-"),
		);
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		fs.mkdirSync(path.join(fixture.configDir, "apps", "run"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "run", "shop-default.sh"),
			`echo "\${AC_PORT_HTTP:-8080}"\n`,
		);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23100-23110",
			isPortBindable: async () => true,
			scriptInfra: {
				launch: async () => ({ status: "running", logPath: "" }),
				status: async () => ({ status: "unknown", logPath: "" }),
				stop: async () => {},
				executionHandle: () => undefined,
			},
		});
		try {
			const started = await controller.start({
				owner: "workflow:lost-handle",
				app: "shop",
			});
			await expect(
				controller.stop(started.instance.id, "shop"),
			).rejects.toMatchObject({ code: "script-handle-unavailable" });
			expect(state.store.getEnvironmentInstances()[0]?.status).toBe("unknown");
			expect(state.store.getPortAllocations()).toHaveLength(1);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("retains script allocations after a runtime stop failure", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-script-stop-fail-"),
		);
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		fs.mkdirSync(path.join(fixture.configDir, "apps", "run"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(fixture.configDir, "apps", "run", "shop-default.sh"),
			`echo "\${AC_PORT_HTTP:-8080}"\n`,
		);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "23170-23180",
			isPortBindable: async () => true,
			scriptInfra: {
				launch: async () => ({ status: "running", logPath: "" }),
				status: async () => ({ status: "running", logPath: "" }),
				observe: async () => ({ status: "running", logPath: "" }),
				stop: async () => {
					throw new Error("permission denied");
				},
				executionHandle: () => ({
					mode: "logged",
					runner: "shell",
					startedAt: "now",
				}),
			},
		});
		try {
			const started = await controller.start({
				owner: "workflow:script-stop-fail",
				app: "shop",
			});
			await expect(
				controller.stop(started.instance.id, "shop"),
			).rejects.toMatchObject({ code: "stop-failed", status: 500 });
			expect(state.store.getEnvironmentInstances()[0]?.status).toBe("unknown");
			expect(state.store.getPortAllocations()).toHaveLength(1);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("requires a profile when several non-default targets are available", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-profiles-"));
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		for (const profile of ["canary", "green"])
			fs.writeFileSync(
				path.join(
					fixture.configDir,
					"apps",
					"compose",
					`shop-${profile}-compose.yml`,
				),
				"services: {}\n",
			);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		try {
			await expect(
				controller.start({ owner: "user", app: "shop" }),
			).rejects.toMatchObject({ code: "profile-required" });
			fs.rmSync(
				path.join(
					fixture.configDir,
					"apps",
					"compose",
					"shop-green-compose.yml",
				),
			);
			const single = await controller.start({ owner: "user", app: "shop" });
			expect(single.instance.targetId).toContain("canary");
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not select a Kubernetes target implicitly", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-kubernetes-"));
		const fixture = composeFixture(root);
		fs.rmSync(fixture.sourcePath);
		fs.writeFileSync(path.join(fixture.checkout, "Chart.yaml"), "name: shop\n");
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			resolveOwnerCheckout: () => fixture.checkout,
		});
		try {
			await expect(
				controller.start({ owner: "workflow:kube", app: "shop" }),
			).rejects.toMatchObject({ code: "runtime-unavailable" });
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("serves the instance API with start, get, stop and repeated-start outcomes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-api-"));
		const fixture = composeFixture(root);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "24000-24010",
			isPortBindable: async () => true,
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		const authority = createInstanceAuthority("test-instance", "test-token");
		const api = createServerApp({
			authority,
			events: new EventBroker(authority.instance),
			credentials: new CredentialRegistry(),
			integrations: { instances: controller } as never,
		});
		const headers = { authorization: `Bearer ${authority.token}` };
		try {
			const start = await api.fetch(
				new Request("http://127.0.0.1/api/v1/environment/instances/start", {
					method: "POST",
					headers,
					body: JSON.stringify({ owner: "workflow:api-run", app: "shop" }),
				}),
			);
			expect(start.status).toBe(200);
			const started = (await start.json()) as {
				value: { outcome: string; instance: { id: string } };
			};
			expect(started.value.outcome).toBe("started");
			const listed = await api.fetch(
				new Request("http://127.0.0.1/api/v1/environment/instances", {
					headers,
				}),
			);
			expect(
				((await listed.json()) as { value: unknown[] }).value,
			).toHaveLength(1);
			const repeated = await api.fetch(
				new Request("http://127.0.0.1/api/v1/environment/instances/start", {
					method: "POST",
					headers,
					body: JSON.stringify({ owner: "workflow:api-run", app: "shop" }),
				}),
			);
			expect(
				((await repeated.json()) as { value: { outcome: string } }).value
					.outcome,
			).toBe("already-running");
			const get = await api.fetch(
				new Request(
					`http://127.0.0.1/api/v1/environment/instances/${started.value.instance.id}?app=shop`,
					{ headers },
				),
			);
			expect(
				((await get.json()) as { value: { status: string } }).value.status,
			).toBe("running");
			const stop = await api.fetch(
				new Request(
					`http://127.0.0.1/api/v1/environment/instances/${started.value.instance.id}/stop`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({ app: "shop" }),
					},
				),
			);
			expect(
				((await stop.json()) as { value: { status: string } }).value.status,
			).toBe("stopped");
		} finally {
			api.events.closeAll();
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("maps exhausted controller allocation to port-unavailable without a row or reservation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-exhausted-"));
		const fixture = composeFixture(root);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "24000-24000",
			isPortBindable: async () => false,
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		try {
			await expect(
				controller.start({ owner: "workflow:exhausted", app: "shop" }),
			).rejects.toMatchObject({ code: "port-unavailable", status: 409 });
			expect(state.store.getEnvironmentInstances()).toEqual([]);
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("releases allocated ports when a Compose start fails", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-start-failed-"),
		);
		const fixture = composeFixture(root);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "24100-24110",
			isPortBindable: async () => true,
			runCommand: async () => ({ exitCode: 1, output: "image build failed" }),
		});
		try {
			await expect(
				controller.start({ owner: "workflow:failed", app: "shop" }),
			).rejects.toMatchObject({ code: "start-failed" });
			expect(
				state.store.findEnvironmentInstance("workflow:failed", "shop")?.status,
			).toBe("failed");
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses infrastructure compose includes for workflow owners", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-include-"));
		const fixture = composeFixture(
			root,
			"include:\n  - ../infrastructure/database/compose.yml\nservices: {}\n",
		);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		try {
			await expect(
				controller.start({ owner: "workflow:include", app: "shop" }),
			).rejects.toMatchObject({ code: "untemplated-target" });
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("reconciliation uses exact Compose project labels, not project-name prefixes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-labels-"));
		const fixture = composeFixture(root);
		const state = tempState();
		const storageId = environmentInstanceStorageId("workflow:label", "shop");
		const instanceId = environmentInstanceId("workflow:label", "shop");
		const project = `shop-${instanceId}`;
		state.store.setEnvironmentInstance({
			id: storageId,
			owner: "workflow:label",
			app: "shop",
			targetId: "app/shop/run/docker/default",
			runtime: "docker",
			checkoutPath: fixture.checkout,
			imageTag: instanceId,
			status: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		});
		state.store.setPortAllocation({
			instanceId: storageId,
			name: "HTTP",
			port: 25200,
		});
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () =>
						Response.json([
							{
								Id: "longer-project",
								Names: [`/${project}-another-project-web-1`],
								State: "running",
								Labels: {
									"com.docker.compose.project": `${project}-another-project`,
								},
								Ports: [],
							},
						])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
		});
		try {
			expect((await controller.list())[0]?.status).toBe("stopped");
			expect(state.store.getPortAllocations(storageId)).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("stops a Docker instance by project labels when its compose file was removed", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-removed-target-"),
		);
		const fixture = composeFixture(root);
		const state = tempState();
		const removedIds: string[] = [];
		let project = "";
		const client = new DockerClient(RUNTIME, {
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === "/containers/json")
					return Response.json(
						[
							{
								Id: "owned",
								Names: [`/${project}-web-1`],
								State: "running",
								Labels: { "com.docker.compose.project": project },
								Ports: [],
							},
							{
								Id: "other",
								Names: [`/${project}-suffix-web-1`],
								State: "running",
								Labels: { "com.docker.compose.project": `${project}-suffix` },
								Ports: [],
							},
						].filter((container) => !removedIds.includes(container.Id)),
					);
				if (init?.method === "DELETE") {
					removedIds.push(url.pathname.split("/")[2] ?? "");
					return new Response(null, { status: 204 });
				}
				return new Response("unexpected", { status: 404 });
			}) as unknown as typeof fetch,
		});
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: { runtime: RUNTIME, client, fallbacks: [] },
			resolveOwnerCheckout: () => fixture.checkout,
			portRange: () => "25300-25310",
			isPortBindable: async () => true,
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		try {
			const started = await controller.start({
				owner: "workflow:deleted-target",
				app: "shop",
			});
			project = `shop-${started.instance.id}`;
			fs.rmSync(fixture.sourcePath);
			const stopped = await controller.stop(started.instance.id, "shop");
			expect(stopped.status).toBe("stopped");
			expect(removedIds).toEqual(["owned"]);
			expect(state.store.getPortAllocations()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("reconciliation marks unobservable runtimes unknown and retains ports", async () => {
		const state = tempState();
		const storageId = environmentInstanceStorageId("workflow:lost", "shop");
		state.store.setEnvironmentInstance({
			id: storageId,
			owner: "workflow:lost",
			app: "shop",
			targetId: "shop:docker:default",
			runtime: "docker",
			checkoutPath: "/worktrees/lost/shop",
			imageTag: "lost-shop",
			status: "running",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastActivityAt: "2026-01-01T00:00:00.000Z",
		});
		state.store.setPortAllocation({
			instanceId: storageId,
			name: "HTTP",
			port: 25000,
		});
		try {
			const unavailable = new EnvironmentInstanceController({
				state: state.store,
				apps: () => [],
				configDir: "/missing",
				docker: {
					runtime: RUNTIME,
					client: new DockerClient(RUNTIME, {
						fetch: (async () =>
							new Response("unavailable", {
								status: 500,
							})) as unknown as typeof fetch,
					}),
					fallbacks: [],
				},
			});
			expect((await unavailable.list())[0]?.status).toBe("unknown");
			expect(state.store.getPortAllocations(storageId)).toHaveLength(1);
			const observedAbsent = new EnvironmentInstanceController({
				state: state.store,
				apps: () => [],
				configDir: "/missing",
				docker: {
					runtime: RUNTIME,
					client: new DockerClient(RUNTIME, {
						fetch: (async () => Response.json([])) as unknown as typeof fetch,
					}),
					fallbacks: [],
				},
			});
			expect((await observedAbsent.list())[0]?.status).toBe("stopped");
			expect(state.store.getPortAllocations(storageId)).toEqual([]);
		} finally {
			state.cleanup();
		}
	});

	test("rejects a non-user compose target with container_name", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "instance-untemplated-"),
		);
		const fixture = composeFixture(
			root,
			"services:\n  web:\n    container_name: shop\n",
		);
		const state = tempState();
		const controller = new EnvironmentInstanceController({
			state: state.store,
			apps: () => [app(fixture.checkout)],
			configDir: fixture.configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async () => Response.json([])) as unknown as typeof fetch,
				}),
				fallbacks: [],
			},
			resolveOwnerCheckout: () => fixture.checkout,
			runCommand: async () => ({ exitCode: 0, output: "" }),
		});
		try {
			await expect(
				controller.start({ owner: "workflow:run-b", app: "shop" }),
			).rejects.toMatchObject({
				code: "untemplated-target",
			});
			expect(state.store.getEnvironmentInstances()).toEqual([]);
		} finally {
			state.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
