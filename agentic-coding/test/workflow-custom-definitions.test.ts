// persist-custom-workflow-definitions: the reserved `custom.` namespace, the
// newest-tier invariants a stored manifest must keep, content-addressed
// per-target storage, re-validation against the current step catalog on load
// (including the fail-closed pin mismatch), and the operator define/start path.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type {
	AgentHandle,
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { isManagedAncestorCommand } from "../src/workflow/cli/caller-environment.ts";
import {
	defineWorkflow,
	operatorChannelConfirmed,
} from "../src/workflow/cli/commands/define.ts";
import { run } from "../src/workflow/cli.ts";
import {
	assertNewestTierInvariants,
	customDefinitionDigest,
	customDefinitionId,
	withCustomIdentity,
} from "../src/workflow/definitions/custom.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { WORKFLOW_STEPS } from "../src/workflow/definitions/steps.ts";
import {
	BUILTIN_CAPABILITIES,
	BUILTIN_EFFECTS,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowManifest,
} from "../src/workflow/registry.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import {
	resolveDefinition,
	resolveDefinitionAt,
	storeDefinition,
	validateDefinition,
} from "../src/workflow/runtime/definitions.ts";
import {
	initializeStore,
	insertDefinition,
	openStore,
	STORE_SCHEMA_VERSION,
	storedDefinition,
} from "../src/workflow/runtime/store.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	prepareWorkflowStart,
	rolesForDefinition,
} from "../src/workflow/startup.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const registry = registerBuiltins();
const TIER = definitionVersionForFamilyTraits(6);
const AT = "2026-01-01T00:00:00.000Z";

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "fake",
};

/** A launch that succeeds without a host, so the assignment render path runs. */
class StubAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	launch(ctx: LaunchContext) {
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	preflight() {}
	prompt() {
		return Effect.void;
	}
	observe(_handle: AgentHandle) {
		return Effect.succeed({ status: "working" as const });
	}
	stop() {
		return Effect.void;
	}
}

function repo(prefix = "custom-"): string {
	// `.herdr-workflow/` holds the store `define` writes; excluding it keeps the
	// checkout clean for the `clean-tree` start requirement the derived
	// no-openspec traits declare.
	return createTempRepoFixture(prefix, {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
}

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

/**
 * A manifest file outside the repository. A file inside the checkout would make
 * the tree dirty, and the derived no-openspec traits require a clean tree at
 * start.
 */
function manifestFile(manifest: unknown): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "custom-manifest-"));
	const file = path.join(directory, "manifest.json");
	fs.writeFileSync(
		file,
		typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
	);
	return file;
}

/** Define a manifest through the command's own work function. The interactive
 * channel gate in `runDefine` is covered separately. */
function define(
	root: string,
	manifest: unknown,
): ReturnType<typeof defineWorkflow> {
	return defineWorkflow(
		registry,
		root,
		manifestFile(manifest),
		() => new Date(AT),
	);
}

/**
 * The authored form of a custom manifest: a newest-tier built-in graph with the
 * fields the store derives (`id`, `version`) and the compilation adds
 * (`digest`, `stepDigests`) removed. Deriving it from a real built-in keeps the
 * fixture honest — it is exactly the graph shape the spec requires a custom
 * definition to keep.
 */
function authored(family: string, label: string): WorkflowManifest {
	const raw = JSON.parse(
		JSON.stringify(registry.definition(family, TIER)),
	) as Record<string, unknown>;
	delete raw.digest;
	delete raw.stepDigests;
	delete raw.id;
	delete raw.version;
	return { ...raw, label } as unknown as WorkflowManifest;
}

/** The graph every routing/gate case mutates: the newest-tier no-openspec
 * family, which carries a routing step before every classifiable step and the
 * review and wiki gates in front of their stages. */
const noOpenspec = (): WorkflowManifest => authored("no-openspec", "Operator");

/** Recompile an authored mutation with its derived identity, the way the store
 * does, so an invariant failure is the only thing that can reject it. */
function compileAuthored(manifest: WorkflowManifest) {
	return registry.compileWorkflow(withCustomIdentity(manifest));
}

function reject(manifest: WorkflowManifest, pattern: RegExp): void {
	expect(() => compileAuthored(manifest)).toThrow(pattern);
}

/** Remove a step and redirect every edge that entered it to `entry` (fixing the
 * initial step when the removed step was the entry point). */
function bypass(
	manifest: WorkflowManifest,
	step: string,
	entry: string,
): WorkflowManifest {
	return {
		...manifest,
		initial: manifest.initial === step ? entry : manifest.initial,
		steps: manifest.steps.filter((id) => id !== step),
		stepRefs: manifest.stepRefs?.filter((ref) => ref.id !== step),
		terminal: manifest.terminal.filter((id) => id !== step),
		edges: manifest.edges
			.filter((edge) => edge.from !== step)
			.map((edge) => (edge.to === step ? { ...edge, to: entry } : edge)),
	};
}

function routingFor(
	definitionId: string,
	definition: CompiledWorkflowDefinition,
): WorkflowRouting {
	const roles = rolesForDefinition(
		definitionId,
		definition.steps,
		registry,
		0,
		definition,
	);
	return {
		defaultProfile: profile.name,
		routes: Object.entries(roles).flatMap(([stepId, roleList]) =>
			roleList.map((role) => ({ stepId, role, profile })),
		),
	};
}

/** A coverage-validating preset over the classifiable steps of a definition
 * (the pattern `test/workflow-startup.test.ts` uses). */
function presetConfig(stepIds: readonly string[]): string {
	return `${JSON.stringify({
		agents: {
			default_profile: "p",
			profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
			presets: {
				fixed: {
					default_profile: "p",
					pools: Object.fromEntries(
						stepIds.map((stepId) => [
							stepId,
							[{ label: "only", profile: "p", default: true }],
						]),
					),
				},
			},
		},
	})}\n`;
}

/** Run a body with `HERDR_WORKFLOW_CONFIG` pointed at a preset file outside the
 * repository (a config inside the worktree would fail the clean-tree check). */
function withPresetConfig<T>(stepIds: readonly string[], body: () => T): T {
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "custom-config-")),
		"config.json",
	);
	fs.writeFileSync(file, presetConfig(stepIds));
	process.env.HERDR_WORKFLOW_CONFIG = file;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
	}
}

function withRemote(root: string): void {
	execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
	execFileSync("git", ["fetch", "-q", "origin"], { cwd: root });
	execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: root });
}

describe("custom workflow definitions", () => {
	test("the newest built-in tier satisfies the custom-manifest invariants", () => {
		for (const family of [
			"openspec",
			"openspec-apply",
			"openspec-propose",
			"openspec-fusion",
			"openspec-fusion-propose",
			"no-openspec",
			"solo",
			"rebase",
			"verify",
		])
			expect(() =>
				assertNewestTierInvariants(registry.definition(family, TIER)),
			).not.toThrow();
		// The documentation families declare no traits and are not
		// custom-eligible: `wiki` is repository-targeted but not a code-change
		// family, and `research` has its own target.
		expect(() =>
			assertNewestTierInvariants(registry.definition("wiki", TIER)),
		).toThrow(/must declare family traits for a repository code-change target/);
		expect(() =>
			assertNewestTierInvariants(registry.definition("research", TIER)),
		).toThrow(/must target a repository/);
	});

	test("the custom namespace is reserved for stored definitions", () => {
		expect(() =>
			registry.registerWorkflow({
				...authored("solo", "shadow"),
				id: customDefinitionId("0".repeat(64)),
				version: 1,
			}),
		).toThrow(/reserved custom namespace/);
		expect(() =>
			registry.definition(customDefinitionId("0".repeat(64)), 1),
		).toThrow(/missing workflow definition/);
	});

	test("rejects a custom manifest without a manifest policy or family traits", () => {
		const missing = noOpenspec();
		delete (missing as { policy?: unknown }).policy;
		reject(missing, /must declare a manifest policy/);

		const traitless = noOpenspec();
		const policy = JSON.parse(JSON.stringify(traitless.policy)) as Record<
			string,
			unknown
		>;
		delete policy.traits;
		traitless.policy = policy as unknown as WorkflowManifest["policy"];
		reject(traitless, /must declare family traits/);

		const wikiTarget = noOpenspec();
		wikiTarget.policy = {
			targetKind: "wiki",
			checkoutRequired: false,
			requiresReadOnlyResearcher: false,
		};
		reject(wikiTarget, /must target a repository/);
	});

	test("rejects a custom manifest without a label the view can render", () => {
		const unlabelled = noOpenspec();
		delete (unlabelled as { label?: unknown }).label;
		reject(unlabelled, /must declare a non-empty label/);

		const blank = noOpenspec();
		blank.label = "   ";
		reject(blank, /must declare a non-empty label/);
	});

	test("rejects a custom manifest without exact step references", () => {
		// The solo graph resolves every step at version 1 without a pin, so the
		// missing step references are the only failure — the newest-tier graphs
		// that need a version-2 step fail structurally first, which is a
		// different (and equally valid) rejection.
		const manifest = authored("solo", "Operator solo");
		delete (manifest as { stepRefs?: unknown }).stepRefs;
		reject(manifest, /must pin exact step references/);
	});

	test("rejects a custom manifest whose classifiable step is not routed", () => {
		reject(
			bypass(noOpenspec(), "core.route-implementation", "core.implementation"),
			/missing routing step core\.route-implementation before core\.implementation/,
		);
	});

	test("rejects a custom manifest that bypasses a routing step", () => {
		const manifest = noOpenspec();
		manifest.edges = manifest.edges.map((edge) =>
			edge.from === "core.triage-route" && edge.outcome === "empty"
				? { ...edge, to: "core.verification" }
				: edge,
		);
		reject(
			manifest,
			/routes core\.verification from core\.triage-route instead of core\.route-verification/,
		);
	});

	test("rejects a custom manifest without the gate in front of a gated stage", () => {
		reject(
			bypass(noOpenspec(), "core.review-gate", "core.developer-review"),
			/missing gate core\.review-gate before core\.developer-review/,
		);
	});

	test("rejects a custom manifest that enters a gated stage around its gate", () => {
		const manifest = noOpenspec();
		manifest.edges = manifest.edges.map((edge) =>
			edge.from === "core.verification" && edge.outcome === "pass"
				? { ...edge, to: "core.developer-review" }
				: edge,
		);
		reject(
			manifest,
			/enters gated stage core\.developer-review from core\.verification instead of gate core\.review-gate/,
		);
	});

	test("storing an identical manifest twice shares one identity and one row", () => {
		const root = repo("custom-store-");
		try {
			const engine = new WorkflowEngine(registry);
			engine.initialize(root);
			const db = openStore(root);
			try {
				const first = storeDefinition(
					registry,
					db,
					noOpenspec(),
					{ kind: "operator" },
					AT,
				);
				const second = storeDefinition(
					registry,
					db,
					noOpenspec(),
					{ kind: "operator" },
					AT,
				);
				expect(second).toEqual(first);
				expect(first.id).toBe(customDefinitionId(first.digest));
				// The printed identity carries the digest the engine pins as well as
				// the content address the identifier is derived from.
				expect(first.definitionDigest).not.toBe(first.digest);
				expect(
					db.query("SELECT count(*) AS count FROM workflow_definitions").get(),
				).toEqual({ count: 1 });
				const row = storedDefinition(db, first.id, 1);
				expect(row?.digest).toBe(first.digest);
				expect(row?.version).toBe(1);
				const stored = JSON.parse(
					requireDefined(row, "stored definition").manifest_json,
				) as WorkflowManifest;
				expect(registry.compileWorkflow(stored).digest).toBe(
					first.definitionDigest,
				);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a rejected custom manifest is never stored", () => {
		const root = repo("custom-reject-");
		try {
			initializeStore(root);
			const db = openStore(root);
			try {
				expect(() =>
					storeDefinition(
						registry,
						db,
						bypass(noOpenspec(), "core.review-gate", "core.developer-review"),
						{ kind: "operator" },
						AT,
					),
				).toThrow(/missing gate/);
				expect(
					db.query("SELECT count(*) AS count FROM workflow_definitions").get(),
				).toEqual({ count: 0 });
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a definition stored under a colliding identity fails closed", () => {
		const root = repo("custom-collision-");
		try {
			initializeStore(root);
			const db = openStore(root);
			try {
				const identity = validateDefinition(registry, noOpenspec());
				// A row that carries the identity's digest under a different
				// identifier: only an out-of-band writer can produce it, and it must
				// never be reported as the stored definition.
				insertDefinition(db, {
					digest: identity.digest,
					id: customDefinitionId("f".repeat(64)),
					version: 1,
					manifest_json: JSON.stringify(identity.manifest),
					origin_json: "{}",
					created_at: AT,
				});
				expect(() =>
					storeDefinition(registry, db, noOpenspec(), { kind: "operator" }, AT),
				).toThrow(/identity collision/);
				// The other direction: the identifier is held by a different digest.
				const other = authored("no-openspec", "Different label");
				const otherIdentity = validateDefinition(registry, other);
				insertDefinition(db, {
					digest: otherIdentity.digest,
					id: identity.id,
					version: 1,
					manifest_json: JSON.stringify(otherIdentity.manifest),
					origin_json: "{}",
					created_at: AT,
				});
				expect(() =>
					storeDefinition(registry, db, noOpenspec(), { kind: "operator" }, AT),
				).toThrow(/identity collision/);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("define reports a rejected manifest in the command's own voice", () => {
		const root = repo("custom-voice-");
		try {
			// A hand-written file that omits a structural field is named, instead
			// of surfacing the registry's own `undefined is not an object`.
			expect(() =>
				define(root, { label: "x", initial: "core.completed" }),
			).toThrow(/^define: .*manifest\.json: manifest is missing "steps"$/);
			expect(() => define(root, "{not json")).toThrow(
				/^define: .*manifest\.json: manifest is not valid JSON/,
			);
			// An invariant failure keeps its own text, now prefixed with the file.
			expect(() =>
				define(
					root,
					bypass(noOpenspec(), "core.review-gate", "core.developer-review"),
				),
			).toThrow(/^define: .*manifest\.json: custom definition .*missing gate/);
			// A field the operator did write is never reported as missing: the
			// pre-check names the key first and the type second.
			expect(() =>
				define(root, { ...noOpenspec(), terminal: "core.closed" }),
			).toThrow(/manifest "terminal" must be an array/);
			expect(() => define(root, { ...noOpenspec(), steps: {} })).toThrow(
				/manifest "steps" must be an array/,
			);
			expect(() => define(root, { ...noOpenspec(), initial: 3 })).toThrow(
				/manifest "initial" must be a non-empty string/,
			);
			expect(() =>
				define(root, { ...noOpenspec(), stepRefs: "core.plan" }),
			).toThrow(/manifest "stepRefs" must be an array/);
			expect(() => define(root, noOpenspec())).not.toThrow();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("define validates the manifest before it migrates or writes the store", () => {
		const root = repo("custom-order-");
		try {
			initializeStore(root);
			const downgrade = new Database(canonicalStorePath(root));
			downgrade.exec("DROP TABLE workflow_definitions; PRAGMA user_version=4");
			downgrade.close();
			expect(() =>
				define(
					root,
					bypass(noOpenspec(), "core.review-gate", "core.developer-review"),
				),
			).toThrow(/missing gate/);
			// A rejected manifest must leave the store exactly as it was.
			const unchanged = new Database(canonicalStorePath(root));
			expect(unchanged.query("PRAGMA user_version").get()).toEqual({
				user_version: 4,
			});
			expect(
				unchanged
					.query(
						"SELECT 1 FROM sqlite_master WHERE name='workflow_definitions'",
					)
					.get(),
			).toBeNull();
			unchanged.close();
			// The same store accepts a valid manifest, migrating it on the write.
			const stored = define(root, noOpenspec());
			const migrated = new Database(canonicalStorePath(root));
			expect(migrated.query("PRAGMA user_version").get()).toEqual({
				user_version: STORE_SCHEMA_VERSION,
			});
			expect(
				migrated
					.query("SELECT count(*) AS count FROM workflow_definitions")
					.get(),
			).toEqual({ count: 1 });
			migrated.close();
			expect(stored.id).toBe(customDefinitionId(stored.digest));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("define refuses a managed caller before it reads or writes anything", async () => {
		const root = repo("custom-channel-");
		const previous = process.env.HERDR_RUN_TOKEN;
		try {
			process.env.HERDR_RUN_TOKEN = "managed-run-token";
			await expect(
				run(["define", "--repo", root, "--file", manifestFile(noOpenspec())]),
			).rejects.toThrow(/interactive operator channel/);
			// Nothing was created: the gate runs before the store is opened.
			expect(fs.existsSync(path.join(root, ".herdr-workflow"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HERDR_RUN_TOKEN;
			else process.env.HERDR_RUN_TOKEN = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the durable host is recognized as a managed ancestor", () => {
		// The predicate the channel gate reads: the current durable host shape is
		// matched, not only the retired pane runtimes. Process ancestry cannot be
		// fabricated from inside a test, so the matcher is asserted directly.
		for (const command of [
			"/usr/local/bin/agentic-coding agent host --workflow-dir /tmp/run",
			"bun /repo/src/cli.ts agent host --workflow-dir /tmp/run",
			"pi --session 1",
			"opencode run",
		])
			expect(isManagedAncestorCommand(command)).toBe(true);
		for (const command of [
			"agentic-coding workflow define --repo /tmp/r --file /tmp/m.json",
			"agentic-coding home",
			"-zsh",
			"tmux",
			"bun test test/workflow-custom-definitions.test.ts",
			"node agent.js host",
		])
			expect(isManagedAncestorCommand(command)).toBe(false);
	});

	test("define requires an interactive operator session or an explicit acknowledgement", () => {
		// The interactive proof the durable write requires in addition to the
		// channel test. It is asserted as the predicate the handler reads, because
		// a managed test process (and any process under the durable host) is
		// refused by the channel gate before this one — which is the point of the
		// fix, not a gap in it.
		expect(operatorChannelConfirmed([], true)).toBe(true);
		expect(operatorChannelConfirmed([], false)).toBe(false);
		expect(operatorChannelConfirmed([], undefined)).toBe(false);
		expect(operatorChannelConfirmed(["--operator"], false)).toBe(true);
		expect(operatorChannelConfirmed(["--operator"], undefined)).toBe(true);
	});

	test("an unresolved custom identity names the repository and the define command", () => {
		const root = repo("custom-missing-");
		try {
			initializeStore(root);
			expect(() =>
				resolveDefinitionAt(registry, root, "custom.deadbeef0000", 1),
			).toThrow(
				/no stored custom definition in .*custom-missing-.*; define it with: workflow define --repo/,
			);
			const db = openStore(root);
			try {
				expect(() =>
					resolveDefinition(registry, db, "custom.deadbeef0000", 1),
				).toThrow(/no stored custom definition in this target store/);
			} finally {
				db.close();
			}
			// A repository without a store at all gets the same actionable answer
			// instead of the store's own "initialize before writing" text.
			const absent = repo("custom-absent-");
			try {
				expect(() =>
					resolveDefinitionAt(registry, absent, "custom.deadbeef0000", 1),
				).toThrow(/cannot read the target store .*workflow define --repo/);
			} finally {
				fs.rmSync(absent, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a target that never stored a definition cannot resolve another target's", () => {
		const source = repo("custom-source-");
		const other = repo("custom-other-");
		try {
			const stored = define(source, noOpenspec());
			initializeStore(other);
			// Warm this process's compile cache from the source store.
			expect(resolveDefinitionAt(registry, source, stored.id, 1).id).toBe(
				stored.id,
			);
			expect(() => resolveDefinitionAt(registry, other, stored.id, 1)).toThrow(
				/no stored custom definition/,
			);
			const db = openStore(other);
			try {
				expect(() => resolveDefinition(registry, db, stored.id, 1)).toThrow(
					/no stored custom definition in this target store/,
				);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(source, { recursive: true, force: true });
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	test("a cached compilation is re-validated against the requesting registry", () => {
		const root = repo("custom-catalog-");
		try {
			const stored = define(root, noOpenspec());
			// Warm this process's compile cache with the full catalog.
			expect(resolveDefinitionAt(registry, root, stored.id, 1).id).toBe(
				stored.id,
			);
			// A registry whose catalog lacks the step the identity pins must not be
			// served the cached compilation.
			const reduced = new WorkflowRegistry(
				BUILTIN_EFFECTS,
				BUILTIN_CAPABILITIES,
			);
			for (const step of WORKFLOW_STEPS)
				if (step.id !== "core.implementation") reduced.registerStep(step);
			expect(() => resolveDefinitionAt(reduced, root, stored.id, 1)).toThrow(
				/missing step definition: core\.implementation@1/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the resolver fails closed on a tampered or missing stored row", () => {
		const root = repo("custom-tamper-");
		try {
			initializeStore(root);
			const db = openStore(root);
			try {
				// (1) A row whose digest does not describe its manifest.
				const identity = validateDefinition(registry, noOpenspec());
				insertDefinition(db, {
					digest: "0".repeat(64),
					id: identity.id,
					version: 1,
					manifest_json: JSON.stringify(identity.manifest),
					origin_json: "{}",
					created_at: AT,
				});
				expect(() => resolveDefinition(registry, db, identity.id, 1)).toThrow(
					/stored digest does not match its manifest/,
				);
				// (2) A row whose text is not even a manifest object.
				const broken = validateDefinition(
					registry,
					authored("no-openspec", "Broken row"),
				);
				insertDefinition(db, {
					digest: broken.digest,
					id: broken.id,
					version: 1,
					manifest_json: '{"steps": [oops',
					origin_json: "{}",
					created_at: AT,
				});
				expect(() => resolveDefinition(registry, db, broken.id, 1)).toThrow(
					/workflow definition pin mismatch: .*JSON Parse error/,
				);
				// (3) A resolution whose pinned digest is not the stored definition's.
				const valid = validateDefinition(
					registry,
					authored("no-openspec", "Pinned digest"),
				);
				insertDefinition(db, {
					digest: valid.digest,
					id: valid.id,
					version: 1,
					manifest_json: JSON.stringify(valid.manifest),
					origin_json: "{}",
					created_at: AT,
				});
				expect(() =>
					resolveDefinition(registry, db, valid.id, 1, "f".repeat(64)),
				).toThrow(/the pinned digest no longer resolves/);
				expect(
					resolveDefinition(registry, db, valid.id, 1, valid.definitionDigest)
						.id,
				).toBe(valid.id);
				// (4) A row tampered with under an unchanged digest is rejected warm
				// exactly as it is cold: the cache never replaces the row check.
				const warm = validateDefinition(
					registry,
					authored("no-openspec", "Warm row"),
				);
				insertDefinition(db, {
					digest: warm.digest,
					id: warm.id,
					version: 1,
					manifest_json: JSON.stringify(warm.manifest),
					origin_json: "{}",
					created_at: AT,
				});
				expect(resolveDefinition(registry, db, warm.id, 1).id).toBe(warm.id);
				db.query(
					"UPDATE workflow_definitions SET manifest_json=? WHERE id=?",
				).run(JSON.stringify({ ...warm.manifest, label: "Tampered" }), warm.id);
				expect(() => resolveDefinition(registry, db, warm.id, 1)).toThrow(
					/stored digest does not match its manifest/,
				);
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("two concurrent define writers converge on one row", async () => {
		const root = repo("custom-race-");
		try {
			const file = manifestFile(noOpenspec());
			const script = [
				'import { registerBuiltins } from "./src/workflow/definitions.ts";',
				'import { defineWorkflow } from "./src/workflow/cli/commands/define.ts";',
				"const stored = defineWorkflow(registerBuiltins(), process.argv[1], process.argv[2], () => new Date());",
				"console.log(JSON.stringify(stored));",
			].join("\n");
			const processes = [0, 1].map(() =>
				Bun.spawn(["bun", "-e", script, root, file], {
					cwd: process.cwd(),
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const exits = await Promise.all(processes.map((child) => child.exited));
			const outputs = await Promise.all(
				processes.map((child) => new Response(child.stdout).text()),
			);
			expect(exits).toEqual([0, 0]);
			const identities = outputs.map(
				(output) => JSON.parse(output.trim()) as { id: string; digest: string },
			);
			expect(identities[0]?.id).toBe(identities[1]?.id);
			const db = openStore(root);
			try {
				expect(
					db.query("SELECT count(*) AS count FROM workflow_definitions").get(),
				).toEqual({ count: 1 });
			} finally {
				db.close();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the operator start path resolves, pins, and starts a stored custom id", () => {
		const root = repo("custom-start-");
		try {
			withRemote(root);
			const stored = define(root, noOpenspec());
			const db = openStore(root);
			try {
				expect(storedDefinition(db, stored.id, 1)?.digest).toBe(stored.digest);
			} finally {
				db.close();
			}
			const definition = resolveDefinitionAt(registry, root, stored.id, 1);
			// The preset covers the definition's classifiable steps, which is what
			// a classifier-routed custom start requires.
			withPresetConfig(
				Object.keys(
					rolesForDefinition(
						stored.id,
						definition.steps,
						registry,
						0,
						definition,
					),
				),
				() => {
					const prepared = prepareWorkflowStart({
						definitionId: stored.id,
						repo: root,
						workflowId: "custom-cli",
						task: "add a flag",
						preset: "fixed",
					});
					expect(prepared.input.definitionId).toBe(stored.id);
					expect(prepared.input.definitionVersion).toBe(1);
					const started = new WorkflowEngine(registry).start(
						prepared.input,
					).view;
					expect(started.definition.id).toBe(stored.id);
					expect(started.definition.version).toBe(1);
					// The digest the command printed is the digest the workflow pins.
					expect(started.definition.digest).toBe(stored.definitionDigest);
					expect(started.currentStep.id).toBe("core.route-implementation");
				},
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("start accepts --type as the definition-id alias and refuses a disagreeing pair", async () => {
		const root = repo("custom-type-");
		try {
			const stored = define(root, noOpenspec());
			// `--type` alone reaches the definition resolver; an identity this
			// repository never stored fails with the actionable diagnostic (and
			// before any drain is scheduled).
			await expect(
				run([
					"start",
					"--workflow-id",
					"custom-typed",
					"--repo",
					root,
					"--type",
					"custom.deadbeef0000",
					"--mode",
					"worktree",
					"--task",
					"add a flag",
				]),
			).rejects.toThrow(/no stored custom definition .*workflow define --repo/);
			await expect(
				run([
					"start",
					"--workflow-id",
					"custom-typed",
					"--repo",
					root,
					"--workflow",
					"solo",
					"--type",
					stored.id,
					"--mode",
					"worktree",
					"--task",
					"add a flag",
				]),
			).rejects.toThrow(/--workflow and --type must name the same definition/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a defined workflow starts, survives a new engine, and dispatches", async () => {
		const root = repo("custom-e2e-");
		try {
			const stored = define(root, noOpenspec());
			const definition = resolveDefinitionAt(registry, root, stored.id, 1);
			const engine = new WorkflowEngine(registry);
			const started: WorkflowView = engine.start({
				repo: root,
				workflowId: "custom-task",
				definitionId: stored.id,
				definitionVersion: 1,
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "add a flag",
				},
				routing: routingFor(stored.id, definition),
			}).view;
			expect(started.definition.id).toBe(stored.id);
			expect(started.definition.version).toBe(1);
			expect(started.definition.digest).toBe(stored.definitionDigest);
			expect(started.currentStep.id).toBe("core.route-implementation");

			// A new engine object stands in for a restarted process: the pin
			// resolves from the store, not from the instance that started it.
			const restarted = new WorkflowEngine(registry);
			const classify = requireDefined(
				restarted
					.claimEffects(root, 100)
					.find((effect) => effect.kind === "model.classify"),
				"routing classify effect",
			);
			const phase = (classify.payload as { phase?: string }).phase ?? "apply";
			const advanced = restarted.dispatch(root, {
				type: "effect.result",
				effectId: classify.id,
				lease: requireDefined(classify.lease, "classify lease"),
				outcome: "complete",
				data: { integration: "routing", phase, answers: {} },
			}).view;
			expect(advanced.currentStep.id).toBe("core.implementation");
			const worker = requireDefined(
				advanced.runs.find((run) => run.role === "worker"),
				"worker run",
			);
			// The launch drain renders the assignment from the stored definition —
			// the effect runner's own resolution path — and hands the worker off.
			const handlers = agentEffectHandlers(root, restarted, {
				registry,
				adapters: new Map([["pi-durable", new StubAdapter()]]),
			});
			await new EffectRunner(root, restarted, handlers).drain();
			const working = restarted.getRun(root, worker.id);
			expect(working.status).toBe("working");
			expect(fs.readFileSync(working.assignmentPath, "utf8")).toContain(
				"add a flag",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a cold process resolves the stored definition and dispatches it", async () => {
		const root = repo("custom-cold-");
		try {
			const stored = define(root, noOpenspec());
			const definition = resolveDefinitionAt(registry, root, stored.id, 1);
			new WorkflowEngine(registry).start({
				repo: root,
				workflowId: "custom-cold-task",
				definitionId: stored.id,
				definitionVersion: 1,
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "add a flag",
				},
				routing: routingFor(stored.id, definition),
			});
			// The restart is genuinely cold: this process's compile cache and the
			// engine that started the workflow are both absent from the child.
			const script = [
				'import { registerBuiltins } from "./src/workflow/definitions.ts";',
				'import { resolveDefinitionAt } from "./src/workflow/runtime/definitions.ts";',
				'import { WorkflowEngine } from "./src/workflow/runtime.ts";',
				"const registry = registerBuiltins();",
				"const [root, id] = process.argv.slice(1);",
				"const definition = resolveDefinitionAt(registry, root, id, 1);",
				"const engine = new WorkflowEngine(registry);",
				'const claim = engine.claimEffects(root, 100).find((effect) => effect.kind === "model.classify");',
				"const view = engine.dispatch(root, {",
				'  type: "effect.result", effectId: claim.id, lease: claim.lease,',
				'  outcome: "complete",',
				'  data: { integration: "routing", phase: (claim.payload || {}).phase || "apply", answers: {} },',
				"}).view;",
				"console.log(JSON.stringify({",
				"  id: definition.id, version: definition.version, digest: definition.digest,",
				"  step: view.currentStep.id, roles: view.runs.map((run) => run.role),",
				"}));",
			].join("\n");
			const child = Bun.spawn(["bun", "-e", script, root, stored.id], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout.trim()) as {
				id: string;
				version: number;
				digest: string;
				step: string;
				roles: string[];
			};
			expect(result.id).toBe(stored.id);
			expect(result.version).toBe(1);
			expect(result.digest).toBe(stored.definitionDigest);
			expect(result.step).toBe("core.implementation");
			expect(result.roles).toContain("worker");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a stored definition the step catalog no longer satisfies blocks its workflow naming the step", () => {
		const root = repo("custom-stale-");
		try {
			const engine = new WorkflowEngine(registry);
			engine.initialize(root);
			// A stored definition that pins a step version the catalog does not
			// register: the state a store is left in when a step version is
			// retired. It is written directly because the store-time compile
			// would reject it today.
			const stale = noOpenspec();
			stale.stepRefs = stale.stepRefs?.map((ref) =>
				ref.id === "core.implementation" ? { ...ref, version: 2 } : ref,
			);
			const stored = withCustomIdentity(stale);
			const digest = customDefinitionDigest(stored);
			const id = customDefinitionId(digest);
			const db = openStore(root);
			try {
				insertDefinition(db, {
					digest,
					id,
					version: 1,
					manifest_json: JSON.stringify(stored),
					origin_json: "{}",
					created_at: AT,
				});
				expect(() => resolveDefinition(registry, db, id, 1)).toThrow(
					/missing step definition: core\.implementation@2/,
				);
			} finally {
				db.close();
			}
			// Pin the workflow to the stale identity, the state it is left in
			// when the version it was started with is later removed.
			const started = engine.start({
				repo: root,
				workflowId: "custom-stale-task",
				definitionId: "solo",
				definitionVersion: TIER,
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "add a flag",
				},
				routing: routingFor("solo", registry.definition("solo", TIER)),
			}).view;
			const pin = new Database(canonicalStorePath(root));
			const row = pin
				.query("SELECT snapshot_json FROM workflow_instances WHERE id=?")
				.get(started.workflowId) as { snapshot_json: string };
			const snapshot = JSON.parse(row.snapshot_json) as {
				definition: unknown;
			};
			snapshot.definition = {
				id,
				version: 1,
				digest,
				stepRefs: stored.stepRefs,
			};
			pin
				.query(
					"UPDATE workflow_instances SET definition_id=?,definition_version=?,definition_digest=?,snapshot_json=? WHERE id=?",
				)
				.run(id, 1, digest, JSON.stringify(snapshot), started.workflowId);
			pin.close();

			const view = engine.status(root, started.workflowId);
			expect(view.health.valid).toBe(false);
			expect(view.definition.label).toBe("Pin mismatch");
			expect(view.health.diagnostic).toContain("pin mismatch");
			expect(view.health.diagnostic).toContain("core.implementation@2");
			// Blocked before further mutation: the dispatch refuses and the
			// revision is untouched.
			expect(() =>
				engine.dispatch(root, {
					type: "operator.repin",
					workflowId: started.workflowId,
					revision: view.revision,
				}),
			).toThrow(/pin mismatch/);
			expect(engine.status(root, started.workflowId).revision).toBe(
				view.revision,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
