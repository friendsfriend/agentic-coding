// Compiled action definitions, validation and registry publication
// (`port-action-execution-to-bun`, task 1.3).
//
// `test/fixtures/actions/definitions.json` is the raw Go definition JSON for a
// fixed input set (`server/pkg/actionregistry/fixtures_test.go`), so every
// assertion here is parity: the Bun compilers must produce the same ids, step
// tree, conditions, ports and executable configuration, and the validator must
// reject the same definitions with the same diagnostics.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionDefinition, ActionStepKind } from "@devenv/types";
import {
	compileDockerLifecycleActions,
	compileGitActions,
	compileInfrastructure,
	compileKubernetesClusterActions,
	compileKubernetesLifecycleActions,
	compileOperation,
	validateKubernetesIdentities,
} from "../src/server/actions/compile.ts";
import { newAction, validateAction } from "../src/server/actions/definition.ts";
import {
	ActionRegistry,
	type ActionSnapshot,
} from "../src/server/actions/registry.ts";
import type { ActionTarget, ToolSet } from "../src/server/actions/targets.ts";

interface FixtureValidation {
	name: string;
	action: ActionDefinition;
	handlers: string[];
	error?: string;
}
interface FixtureGroup {
	name: string;
	actions: ActionDefinition[];
}
interface DefinitionFixture {
	compiled: FixtureGroup[];
	validation: FixtureValidation[];
}

const FIXTURES = path.join(import.meta.dir, "fixtures", "actions");
const fixture: DefinitionFixture = JSON.parse(
	fs.readFileSync(path.join(FIXTURES, "definitions.json"), "utf8"),
);

/**
 * The fixture is machine-independent: the user's home is a `{{HOME}}` recipe
 * key (the kubernetes cluster actions embed the kubeconfig path), and Go emits
 * `"inputs": null` where the port carries an empty array.
 */
function normalize(value: unknown): unknown {
	const encoded = JSON.stringify(value)
		.replaceAll(os.homedir(), "{{HOME}}")
		.replaceAll('"inputs":null', '"inputs":[]');
	return JSON.parse(encoded);
}

function flatten(step: ActionDefinition["root"]): ActionDefinition["root"][] {
	return [step, ...(step.children ?? []).flatMap(flatten)];
}

function group(name: string): FixtureGroup {
	const found = fixture.compiled.find((g) => g.name === name);
	if (!found) throw new Error(`missing fixture group ${name}`);
	return found;
}

const handlers = {
	has: (kind: string) =>
		["command", "process", "readiness", "operation", "cleanup"].includes(kind),
};

const ALL_TOOLS: ToolSet = {
	docker: true,
	podman: true,
	dockerCompose: true,
	podmanCompose: true,
	tmux: true,
	kind: true,
	kubectl: true,
	helm: true,
};

function dockerTarget(profile: string): ActionTarget {
	return {
		id: "app/api/run/docker",
		action: "run",
		runtime: "docker",
		label: "Run",
		...(profile === "" ? {} : { profile }),
		sourcePath: "/home/devenv/apps/api/docker-compose.yml",
		workingDir: "/home/devenv/apps/api",
	};
}

function kubernetesTarget(profile: string): ActionTarget {
	return {
		id: "app/api/run/kubernetes",
		action: "run",
		runtime: "kubernetes",
		label: "Run",
		provider: "docker",
		...(profile === "" ? {} : { profile }),
		sourcePath: "/home/devenv/apps/api/chart",
		kubernetes: {
			provider: "docker",
			chartPath: "/home/devenv/apps/api/chart",
			release: "api-local",
			namespace: "api",
			valuesFiles: ["/home/devenv/apps/api/chart/values.yaml"],
		},
	};
}

const scriptInfra = (runner: string) => ({
	ident: "worker",
	displayName: "Worker",
	type: "script",
	shellPath: "/home/devenv/infra/worker.sh",
	powerShellPath: "/home/devenv/infra/worker.ps1",
	defaultRunner: runner,
	cwd: "/home/devenv/infra",
	args: ["--verbose"],
	env: { WORKER_MODE: "dev" },
	logPath: "/home/devenv/logs/worker.log",
});

const COMPILED: Record<string, () => ActionDefinition[]> = {
	"git-actions": () => compileGitActions("api", "/home/devenv/apps/api"),
	"git-action-without-checkout": () => compileGitActions("api", ""),
	"git-action-without-ident": () => compileGitActions("", ""),
	"docker-lifecycle-default-profile": () =>
		compileDockerLifecycleActions("api", dockerTarget("")),
	"docker-lifecycle-named-profile": () =>
		compileDockerLifecycleActions("api", dockerTarget("dev")),
	"kubernetes-lifecycle-default-profile": () =>
		compileKubernetesLifecycleActions("api", kubernetesTarget("")),
	"kubernetes-lifecycle-named-profile": () =>
		compileKubernetesLifecycleActions("api", kubernetesTarget("preview")),
	"kubernetes-lifecycle-unmatched-target": () =>
		compileKubernetesLifecycleActions("api", dockerTarget("")),
	"kubernetes-cluster-all-tools": () =>
		compileKubernetesClusterActions(ALL_TOOLS, os.homedir()),
	"kubernetes-cluster-no-tools": () =>
		compileKubernetesClusterActions({ docker: true }, os.homedir()),
	"infrastructure-docker": () =>
		compileInfrastructure({
			ident: "postgres",
			displayName: "Postgres",
			type: "docker",
			containerBaseName: "devenv-postgres",
		}),
	"infrastructure-script-shell": () =>
		compileInfrastructure(scriptInfra("shell")),
	"infrastructure-script-powershell": () =>
		compileInfrastructure(scriptInfra("powershell")),
	"infrastructure-kubernetes": () =>
		compileInfrastructure({
			ident: "redis",
			displayName: "Redis",
			type: "kubernetes",
			kubernetes: {
				profile: "local",
				provider: "docker",
				cluster: "devenv",
				chartPath: "/home/devenv/infra/redis",
				release: "redis-local",
				namespace: "redis",
				values: ["/home/devenv/infra/redis/values.yaml"],
				timeout: "10m",
			},
		}),
	operation: () => [
		compileOperation(
			{ kind: "kubernetes", id: "local" },
			"stop",
			"kubernetes",
			"Stop",
			"kubernetes",
			"command",
			"cleanup",
		),
	],
};

describe("compiled definitions", () => {
	for (const [name, compile] of Object.entries(COMPILED)) {
		test(`${name} matches the definition Go produced`, () => {
			expect(normalize(compile())).toEqual(normalize(group(name).actions));
		});
	}

	test("every fixture group is covered by a ported compiler", () => {
		expect(fixture.compiled.map((g) => g.name).sort()).toEqual(
			Object.keys(COMPILED).sort(),
		);
	});

	test("a missing checkout changes availability, never identity", () => {
		// The checkout directory is executable configuration and does change;
		// identity — action ids, step ids and labels — must not.
		const identityOf = (definitions: ActionDefinition[]) =>
			definitions.map((definition) => ({
				id: definition.id,
				type: definition.type,
				label: definition.label,
				steps: flatten(definition.root).map((step) => ({
					id: step.id,
					kind: step.kind,
					label: step.label,
				})),
			}));
		const withCheckout = compileGitActions("api", "/home/devenv/apps/api");
		const withoutCheckout = compileGitActions("api", "");
		expect(identityOf(withoutCheckout)).toEqual(identityOf(withCheckout));
		expect(withoutCheckout[0]?.availability).toEqual({
			available: false,
			reason: "checkout required",
		});
	});
});

describe("definition validation", () => {
	for (const c of fixture.validation) {
		test(`${c.name} matches the Go decision`, () => {
			const run = () =>
				validateAction(c.action, { has: (k) => c.handlers.includes(k) });
			if (c.error === undefined) {
				expect(run).not.toThrow();
			} else {
				expect(run).toThrow(c.error);
			}
		});
	}

	test("the fixture exercises both accepted and rejected definitions", () => {
		expect(
			fixture.validation.filter((c) => c.error === undefined).length,
		).toBeGreaterThan(1);
		expect(
			fixture.validation.filter((c) => c.error !== undefined).length,
		).toBeGreaterThan(8);
	});
});

describe("definition immutability", () => {
	test("a snapshot hands out copies, so a caller cannot mutate it", () => {
		const definition = compileGitActions("api", "/checkout")[0];
		if (!definition) throw new Error("no definition");
		const copy = newAction(definition);
		copy.label = "mutated";
		copy.inputs.push({
			key: "x",
			type: "string",
			scope: "action",
			visibility: "public",
		});
		if (!copy.root.children?.[0]) throw new Error("no child step");
		copy.root.children[0].label = "mutated";
		expect(definition.label).toBe("Pull");
		expect(definition.inputs).toEqual([]);
		expect(definition.root.children?.[0]?.label).toBe("Get ref");
	});
});

describe("kubernetes identity validation", () => {
	const target = (
		cluster: string,
		context: string,
		provider: "docker" | "podman",
	): ActionTarget => ({
		id: "t",
		action: "run",
		runtime: "kubernetes",
		label: "Run",
		provider,
		sourcePath: "/chart",
		kubernetes: {
			provider,
			clusterName: cluster,
			contextName: context,
			chartPath: "/chart",
			release: "r",
		},
	});

	test("accepts distinct identities and the same provider", () => {
		expect(() =>
			validateKubernetesIdentities([
				target("shop", "kind-shop", "docker"),
				target("shop", "kind-shop", "docker"),
				target("other", "kind-other", "podman"),
			]),
		).not.toThrow();
	});

	test("rejects one cluster/context claimed by two providers", () => {
		expect(() =>
			validateKubernetesIdentities([
				target("shop", "kind-shop", "docker"),
				target("shop", "kind-shop", "podman"),
			]),
		).toThrow(/claimed by providers/);
	});

	test("keeps the legacy default identity compatible", () => {
		expect(() =>
			validateKubernetesIdentities([
				target("", "", "docker"),
				target("devenv", "kind-devenv", "podman"),
			]),
		).not.toThrow();
	});
});

describe("registry publication", () => {
	test("a failed rebuild keeps the previous snapshot current", async () => {
		const registry = new ActionRegistry();
		const good = compileGitActions("api", "/checkout").slice(0, 2);
		const first = await registry.rebuild([
			{ name: "git", compile: () => good },
		]);
		expect(first.version).toBe(1);

		await expect(
			registry.rebuild([
				{ name: "git", compile: () => compileGitActions("api", "/checkout") },
				{
					name: "duplicate",
					compile: () => compileGitActions("api", "/checkout"),
				},
			]),
		).rejects.toThrow(
			/duplicate action id app\/api\/action\/pull\/git\/default/,
		);

		expect(registry.snapshot()).toBe(first);
		expect(registry.snapshot().version).toBe(1);
		expect(registry.snapshot().definitions).toHaveLength(2);
	});

	test("an invalid definition rejects the whole publication", async () => {
		const registry = new ActionRegistry();
		await registry.rebuild([
			{ name: "git", compile: () => compileGitActions("api", "/c") },
		]);
		const version = registry.snapshot().version;
		const broken = compileGitActions("api", "/c")[0];
		if (!broken) throw new Error("no definition");
		await expect(
			registry.rebuild(
				[
					{
						name: "broken",
						// The kind is deliberately outside the model, which is exactly
						// what the registry must refuse to publish.
						compile: () => [
							{
								...broken,
								root: { ...broken.root, kind: "unsupported" as ActionStepKind },
							},
						],
					},
				],
				handlers,
			),
		).rejects.toThrow(/no handler for kind unsupported/);
		expect(registry.snapshot().version).toBe(version);
	});

	test("a rebuild publishes one new version in id order", async () => {
		const registry = new ActionRegistry();
		const snapshot = await registry.rebuild(
			[{ name: "git", compile: () => compileGitActions("api", "/checkout") }],
			handlers,
		);
		expect(snapshot.version).toBe(1);
		const ids = snapshot.definitions.map((d) => d.id);
		expect(ids).toEqual([...ids].sort());
		expect(new Set(ids).size).toBe(ids.length);
		expect(snapshot.get("app/api/action/pull/git/default")).toBeDefined();
		expect(snapshot.get("missing")).toBeUndefined();
		expect(
			snapshot.forResource({ kind: "app", id: "api" }).map((d) => d.type),
		).toEqual([
			"branches",
			"checkout",
			"fetch",
			"pull",
			"push",
			"worktree-add",
			"worktree-list",
			"worktree-remove",
		]);
	});

	test("an empty registry is version 0 with nothing published", () => {
		const snapshot: ActionSnapshot = new ActionRegistry().snapshot();
		expect(snapshot.version).toBe(0);
		expect(snapshot.definitions).toEqual([]);
		expect(snapshot.diagnostics).toEqual([]);
	});

	test("versions advance monotonically across successful rebuilds", async () => {
		const registry = new ActionRegistry();
		await registry.rebuild([{ name: "git", compile: () => [] }]);
		await registry.rebuild([{ name: "git", compile: () => [] }]);
		const third = await registry.rebuild([
			{ name: "git", compile: () => compileGitActions("api", "/c") },
		]);
		expect(third.version).toBe(3);
	});

	test("a provider that fails to compile keeps the previous snapshot", async () => {
		const registry = new ActionRegistry();
		const first = await registry.rebuild([
			{ name: "git", compile: () => compileGitActions("api", "/c") },
		]);
		await expect(
			registry.rebuild([
				{
					name: "boom",
					compile: () => Promise.reject(new Error("discovery failed")),
				},
			]),
		).rejects.toThrow("discovery failed");
		expect(registry.snapshot()).toBe(first);
	});
});
