// The `env-setup` validation gate (add-environment-setup-workflow):
// deterministic, structural checks over the drafts before a developer is asked
// to approve them, plus a real start of the drafted run targets.
//
// Nothing here is agent-owned: the checks are the same every round (drafts name
// a documented configuration path, parse, discover and compile, `AC_OTEL_*` is
// referenced by every drafted run target, no host port collides with another
// app's definition, every referenced `${VAR}` exists) and the start reports
// readiness from the action engine. Both the compiler and the starter are
// injected, so the gate's pass and fail paths are testable with doubles and the
// effect handler supplies the real ones.
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "../../env-file.ts";
import {
	candidatesOfTargets,
	DEFAULT_DECLARATIONS_DIR,
	type DefaultDeclaration,
	decideDefaultTarget,
	defaultDeclarationPath,
	defaultDeclarationRelative,
	readDefaultDeclaration,
	resolveDefaultTarget,
} from "../actions/default-target.ts";
import {
	configDirEntries,
	discoverActionTargets,
} from "../actions/discovery.ts";
import { compileContainerTargetsWithTools } from "../actions/target-compile.ts";
import type { ActionTarget, AppAction } from "../actions/targets.ts";
import { checkToolAvailability } from "../actions/toolcheck.ts";
import {
	assertSetupDraftsDir,
	draftSourceRoot,
	hasStagedRoot,
	isAllowedDraftPath,
	listSetupDraftEntries,
	listSetupDraftFiles,
	reviewedDigest,
	stagedChangeSet,
} from "./setup-drafts.ts";

/**
 * Which discovery action a drafted file must resolve under. Every drafted
 * action the author may write is covered: the run definitions and the build/test
 * definitions, so a draft that no action picks up is reported instead of
 * reaching the approval gate as if it were runnable.
 */
const DRAFT_ACTIONS: ReadonlyArray<{ prefix: string; action: AppAction }> = [
	{ prefix: "apps/compose/", action: "run" },
	{ prefix: "apps/run/", action: "run" },
	{ prefix: "apps/kubernetes/", action: "run" },
	{ prefix: "apps/k8s/", action: "run" },
	{ prefix: "apps/build/", action: "build" },
	{ prefix: "apps/build/", action: "test" },
	// The per-app default declaration is the one drafted path that is not itself a
	// target (`fix-default-target-after-promotion`), and it may name any action.
	{ prefix: `${DEFAULT_DECLARATIONS_DIR}/`, action: "build" },
	{ prefix: `${DEFAULT_DECLARATIONS_DIR}/`, action: "test" },
	{ prefix: `${DEFAULT_DECLARATIONS_DIR}/`, action: "run" },
];

/** How long one Kubernetes reachability probe may take before it answers
 * "not reachable": the gate must not block on an unreachable API server. */
const KUBERNETES_PROBE_TIMEOUT_MS = 5000;

export interface SetupValidationFinding {
	/** Stable check id, so the author's report groups findings by check. */
	readonly check:
		| "no-drafts"
		| "non-regular-file"
		| "staged-deletion"
		| "unexpected-path"
		| "unparsable"
		| "empty-file"
		| "discover"
		| "undiscovered"
		| "compile"
		| "otel"
		| "port-collision"
		| "missing-variable"
		| "start"
		| "build"
		| "test"
		| "infra"
		| "no-default-target"
		| "default-declaration"
		| "no-test-target"
		| "skipped";
	readonly message: string;
	/** Configuration-relative draft path or target id, when the finding has one. */
	readonly subject?: string;
	/** False for a finding the developer must see but that does not fail the
	 * gate (an app that genuinely declares no test target). Defaults to true. */
	readonly blocking?: boolean;
}

export interface SetupTargetStartResult {
	readonly ready: boolean;
	readonly detail?: string;
}

/** Starts one target and reports whether it reached readiness. */
export type SetupTargetStarter = (
	target: ActionTarget,
) => Promise<SetupTargetStartResult>;

/** The outcome of one build or test run of a target. A step the machine cannot
 * run (no docker daemon, no tool) is `skipped` with a reason, never a pass. */
export interface SetupTargetRunResult {
	readonly ok: boolean;
	readonly skipped?: boolean;
	readonly exitCode?: number | null;
	readonly logTail?: string;
	readonly detail?: string;
}

/** Builds or tests one target; a thrown error is reported as a failed step. */
export type SetupTargetRunner = (
	target: ActionTarget,
) => Promise<SetupTargetRunResult>;

/** Parses one modified shared infrastructure definition; the real one is
 * `docker compose -f <staged> config -q`. */
export type SetupInfrastructureParser = (relative: string) => Promise<{
	readonly ok: boolean;
	readonly skipped?: boolean;
	readonly exitCode?: number | null;
	readonly detail?: string;
	readonly logTail?: string;
}>;

/** Per-step deadlines and the whole-gate wall-clock budget. A step that runs
 * past its deadline is reported as `skipped` with the reason and fails the
 * gate: a hung build must never hold the workflow, and it is never a pass. */
export interface SetupValidationTimeouts {
	readonly compileMs?: number;
	readonly buildMs?: number;
	readonly startMs?: number;
	readonly testMs?: number;
	readonly infraMs?: number;
	readonly budgetMs?: number;
}

const DEFAULT_TIMEOUTS: Required<SetupValidationTimeouts> = {
	compileMs: 2 * 60 * 1000,
	buildMs: 15 * 60 * 1000,
	startMs: 10 * 60 * 1000,
	testMs: 10 * 60 * 1000,
	infraMs: 60 * 1000,
	budgetMs: 45 * 60 * 1000,
};

/** A step that ran past its deadline. */
class StepTimeout extends Error {
	constructor() {
		super("the step exceeded its deadline");
		this.name = "StepTimeout";
	}
}

/** Runs one step under a deadline; a timeout is data, never a thrown defect. */
async function boundedStep<T>(
	work: Promise<T>,
	ms: number,
): Promise<{ readonly timedOut: boolean; readonly value?: T }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new StepTimeout()), ms);
				(timer as { unref?: () => void }).unref?.();
			}),
		]);
		return { timedOut: false, value };
	} catch (error) {
		if (error instanceof StepTimeout) return { timedOut: true };
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Compiles one target; a compile failure is thrown and reported as a finding. */
export type SetupTargetCompiler = (target: ActionTarget) => Promise<void>;

export interface SetupValidationContext {
	readonly configDir: string;
	readonly draftsDir: string;
	readonly appIdent: string;
	readonly checkoutDir: string;
	readonly platform?: string;
	readonly startTarget: SetupTargetStarter;
	readonly compileTarget?: SetupTargetCompiler;
	/** The real default build/test run (`env_build`/`env_test`). Absent means the
	 * gate states the step as skipped rather than pretending it passed. */
	readonly buildTarget?: SetupTargetRunner;
	readonly testTarget?: SetupTargetRunner;
	/** Parses every modified shared infrastructure definition. Absent means the
	 * step is stated as skipped rather than pretended. */
	readonly parseInfrastructure?: SetupInfrastructureParser;
	readonly timeouts?: SetupValidationTimeouts;
	/** The run's pinned promotion secret: it authenticates the staged base
	 * snapshot, so a `base.json` written by hand is not adopted. */
	readonly secret?: string;
	/** Released after the gate unless the workflow keeps the app. */
	readonly releaseTarget?: () => Promise<void>;
	/** Host ports the *other* apps already declare, keyed by port. */
	readonly otherAppPorts?: () => Map<number, string>;
	/** Whether a Kubernetes cluster the target names is reachable. */
	readonly clusterAvailable?: (target: ActionTarget) => boolean;
	/** Variables the environment file provides; defaults to the config `.env`. */
	readonly envFileVariables?: () => Map<string, string>;
	readonly processEnv?: Record<string, string | undefined>;
}

export interface SetupValidationTargetReport {
	readonly id: string;
	readonly runtime: string;
	readonly profile: string;
	readonly sourcePath: string;
	readonly drafted: boolean;
	readonly started: "ready" | "failed" | "skipped";
	readonly detail?: string;
}

export interface SetupValidationReport {
	readonly ok: boolean;
	readonly app: string;
	readonly drafts: string[];
	readonly targets: SetupValidationTargetReport[];
	readonly findings: SetupValidationFinding[];
	readonly variables: { readonly used: string[]; readonly missing: string[] };
	readonly otel: Array<{ readonly target: string; readonly ok: boolean }>;
	/** The real path the gate ran, step by step: discover, compile, the default
	 * build, start and the default test, with each step's outcome. */
	readonly steps: SetupValidationStepReport[];
	/** The default target the gate chose per action, so a draft with two
	 * default-profile candidates cannot silently pass. */
	readonly defaults: SetupValidationDefault[];
	/** The digest of every drafted file the gate validated, in declaration order:
	 * the promotion refuses to publish anything else, so the approval authorises
	 * the bytes that become live and not merely a path list. */
	readonly reviewed: Record<string, string>;
}

export interface SetupValidationStepReport {
	/** `discover`, `compile`, `build`, `start` or `test`. */
	readonly step: string;
	readonly action: string;
	readonly targetId: string;
	readonly status: "ok" | "failed" | "skipped";
	readonly exitCode?: number | null;
	readonly durationMs: number;
	readonly logTail?: string;
	readonly detail?: string;
	/** The target ids the step saw (the discover step). */
	readonly targetsSeen?: string[];
}

export interface SetupValidationDefault {
	readonly action: "build" | "run" | "test";
	readonly targetId: string;
	readonly profile: string;
	readonly runtime: string;
	/** How the default was decided, so the approval summary can say why
	 * (`fix-default-target-after-promotion`): `declared` names the specific
	 * missing statement the developer should see when the choice was ambiguous. */
	readonly source?: "declared" | "only-candidate" | "preference";
	/** The declaration that named it, when one did. */
	readonly declared?: string;
	/** Live target ids this draft supersedes (same action and profile): a draft
	 * cannot delete a live definition, so the file it writes is the one the app
	 * means to use, and the report says which live target it displaces. */
	readonly superseded?: string[];
}

/** Log tail of one step: the last 40 lines, at most 8 KiB. */
export function boundedStepLog(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const lines = text.split("\n");
	const tail = lines.slice(Math.max(0, lines.length - 40)).join("\n");
	return tail.length > 8192 ? tail.slice(tail.length - 8192) : tail;
}

/** The default target of one action: the `default` profile's own target, and
 * never a silent guess between several candidates (mirrors `agentTarget`). */
export function defaultTargetOf(targets: readonly ActionTarget[]): {
	readonly target?: ActionTarget;
	readonly ambiguous?: ActionTarget[];
} {
	if (targets.length === 0) return {};
	const preferred = targets.filter(
		(candidate) => (candidate.profile ?? "default") === "default",
	);
	if (preferred.length === 1) return { target: preferred[0] as ActionTarget };
	if (preferred.length > 1)
		return {
			ambiguous: [...preferred].sort((a, b) => (a.id < b.id ? -1 : 1)),
		};
	if (targets.length === 1) return { target: targets[0] as ActionTarget };
	return { ambiguous: [...targets].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

/**
 * The effective target set for the default choice: a *drafted* target supersedes
 * every live target of the same action and profile.
 *
 * The staged root is a copy of the live configuration, so the superseded
 * definition is discovered whether or not the author drafts the replacing file,
 * and a draft cannot remove it (deletions are never published). The motivating
 * case is exactly this: a live `apps/build/<app>-build.Dockerfile` that cannot
 * build beside a drafted `apps/build/<app>-build.sh` that works. Treating the
 * draft as the successor is the semantics the change promises ("a drafted build
 * target for the same app/profile should replace the one it supersedes"), and the
 * report names what it displaced.
 */
export function supersededTargets(
	targets: readonly ActionTarget[],
	draftedPaths: ReadonlySet<string>,
): ActionTarget[] {
	const drafted = targets.filter((target) =>
		draftedPaths.has(target.sourcePath),
	);
	if (drafted.length === 0) return [...targets];
	const key = (target: ActionTarget): string =>
		`${target.action}|${target.profile ?? "default"}`;
	const draftedKeys = new Set(drafted.map(key));
	return targets.filter(
		(target) =>
			draftedPaths.has(target.sourcePath) || !draftedKeys.has(key(target)),
	);
}

/** The superseded live target ids for one drafted choice, for the report. */
export function supersededIds(
	targets: readonly ActionTarget[],
	effective: readonly ActionTarget[],
): string[] {
	const kept = new Set(effective.map((target) => target.id));
	return targets
		.filter((target) => !kept.has(target.id))
		.map((target) => target.id)
		.sort();
}

/** The run target the platform would start by default: a declaration in
 * `apps/defaults/<app>.json` when one names it, else Docker, then a script,
 * then Kubernetes — the same precedence `selectTarget` applies, resolved
 * through the one shared rule (`fix-default-target-after-promotion`). */
export function preferredRunTarget(
	targets: readonly ActionTarget[],
	declared?: string,
	declarationPath?: string,
): ActionTarget | undefined {
	const decision = decideDefaultTarget({
		action: "run",
		candidates: candidatesOfTargets(targets),
		...(declared ? { declared } : {}),
		...(declarationPath ? { declarationPath } : {}),
	});
	if (!decision.target) return undefined;
	return targets.find((target) => target.id === decision.target?.id);
}

/**
 * Validate every drafted definition and start every drafted run target.
 * Docker is always started (a setup that cannot start the app's own container
 * target has not been validated); script and Kubernetes targets only when a
 * draft defines them, and a Kubernetes target only when its cluster exists.
 */
export async function validateSetupDrafts(
	context: SetupValidationContext,
): Promise<SetupValidationReport> {
	const steps: SetupValidationStepReport[] = [];
	const defaults: SetupValidationDefault[] = [];
	const findings: SetupValidationFinding[] = [];
	const reviewed: Record<string, string> = {};
	const timeouts = { ...DEFAULT_TIMEOUTS, ...context.timeouts };
	const gateStartedAt = Date.now();
	const budgetLeft = (): number =>
		timeouts.budgetMs - (Date.now() - gateStartedAt);
	const report = (
		value: Omit<SetupValidationReport, "steps" | "defaults" | "reviewed">,
	): SetupValidationReport => ({ ...value, steps, defaults, reviewed });
	// The drafts directory arrives from the workflow's pinned metadata: a value
	// that is not this configuration's drafts root is a named finding, never a
	// discovery over an unknown tree.
	try {
		assertSetupDraftsDir(context.configDir, context.draftsDir);
	} catch (error) {
		return report({
			ok: false,
			app: context.appIdent,
			drafts: [],
			targets: [],
			findings: [{ check: "unexpected-path", message: message(error) }],
			variables: { used: [], missing: [] },
			otel: [],
		});
	}
	// The staged configuration root is where a draft really lives
	// (`staged-env-setup-config-root`): a complete copy of the live configuration
	// at its own relative layout, so a draft's `include:` and relative mounts
	// resolve exactly as they will after promotion. A state directory without a
	// staged root keeps the legacy per-file behaviour.
	const sourceRoot = draftSourceRoot(context.draftsDir);
	// The change set is derived once and every later decision reads it: the draft
	// list, the non-regular and deletion findings (one walk, one answer).
	const changed = hasStagedRoot(context.draftsDir)
		? stagedChangeSet(context.draftsDir, context.secret)
		: undefined;
	const nonRegularDrafts = new Set<string>();
	if (changed) {
		for (const entry of changed.entries)
			if (entry.kind !== "file") {
				nonRegularDrafts.add(entry.relative);
				findings.push({
					check: "non-regular-file",
					message: `${entry.relative}: drafts must be plain files (${entry.kind})`,
					subject: entry.relative,
				});
			}
		for (const relative of changed.deletions)
			findings.push({
				check: "staged-deletion",
				message: `${relative}: a live configuration path is missing from the staged root; deletions are never published`,
				subject: relative,
			});
	} else {
		for (const entry of listSetupDraftEntries(context.draftsDir))
			if (entry.kind !== "file") {
				nonRegularDrafts.add(entry.relative);
				findings.push({
					check: "non-regular-file",
					message: `${entry.relative}: drafts must be plain files (${entry.kind})`,
					subject: entry.relative,
				});
			}
	}
	const drafts = (changed?.entries ?? [])
		.filter((entry) => entry.kind === "file")
		.map((entry) => entry.relative);
	const legacyDrafts = changed ? [] : listSetupDraftFiles(context.draftsDir);
	for (const relative of legacyDrafts) drafts.push(relative);
	// The reviewed digest of every drafted file, taken from the directory the
	// promotion writes from (`sourceRoot`): the promotion refuses to publish
	// anything else, so the developer's approval covers the bytes that become live
	// and not merely a path list (the authoring agent can write into this tree
	// while the approval waits). Recorded in every mode, so a run whose staged
	// root disappears cannot present an empty review.
	if (drafts.length === 0)
		findings.push({
			check: "no-drafts",
			message: `no drafts were found in ${context.draftsDir}`,
		});

	const draftTexts = new Map<string, string>();
	for (const relative of drafts) {
		const filePath = path.join(sourceRoot, ...relative.split("/"));
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			findings.push({
				check: "unparsable",
				message: `${relative}: unreadable (${message(error)})`,
				subject: relative,
			});
			continue;
		}
		draftTexts.set(relative, text);
		// A draft that does not name a documented configuration path is refused
		// here: the promotion would otherwise publish a file the configuration
		// does not define (`agent-definitions/instructions/env-setup.md`).
		if (!isAllowedDraftPath(relative))
			findings.push({
				check: "unexpected-path",
				message: `${relative}: drafts must mirror the configuration layout (build, run, compose, kubernetes, infrastructure definitions/compose)`,
				subject: relative,
			});
		if (text.trim() === "")
			findings.push({
				check: "empty-file",
				message: `${relative}: the draft is empty`,
				subject: relative,
			});
		// A JSON definition must parse: a malformed draft must never reach the
		// approval gate as if it were runnable.
		if (relative.endsWith(".json")) {
			try {
				JSON.parse(text);
			} catch (error) {
				findings.push({
					check: "unparsable",
					message: `${relative}: invalid JSON (${message(error)})`,
					subject: relative,
				});
			}
		}
	}

	for (const relative of drafts) {
		const text = draftTexts.get(relative);
		// The digest of the *content the gate read and validated*: the promotion
		// compares it with the bytes it is about to write, so a rewrite between the
		// two cannot be published un-reviewed.
		if (text !== undefined) reviewed[relative] = reviewedDigest(text);
	}
	// Discovery resolves the staged root through the same per-file overlay a held
	// app run uses, so what validates is exactly what would run. It throws on a
	// malformed definition (for example a `x-devenv.requires` block that is not
	// inline JSON), which is a finding the author must see — never a defect that
	// parks the workflow.
	const targetsByAction = new Map<AppAction, ActionTarget[]>();
	const discovered = (action: AppAction): ActionTarget[] => {
		const cached = targetsByAction.get(action);
		if (cached) return cached;
		let found: ActionTarget[] = [];
		try {
			found = discoverActionTargets({
				appIdent: context.appIdent,
				localDir: context.checkoutDir,
				action,
				configDir: context.configDir,
				configOverlay: sourceRoot,
				...(context.platform ? { platform: context.platform } : {}),
			});
		} catch (error) {
			findings.push({
				check: "discover",
				message: `discovery over the drafts failed: ${message(error)}`,
			});
		}
		targetsByAction.set(action, found);
		return found;
	};

	const draftedPaths = new Set<string>();
	const draftedActions = new Map<string, AppAction[]>();
	for (const relative of drafts) {
		const actions = DRAFT_ACTIONS.filter((entry) =>
			relative.startsWith(entry.prefix),
		).map((entry) => entry.action);
		if (actions.length === 0) continue;
		const absolute = path.join(sourceRoot, ...relative.split("/"));
		draftedPaths.add(absolute);
		draftedActions.set(absolute, actions);
	}
	for (const [draftPath, actions] of draftedActions) {
		const relative = relativeOfDraft(sourceRoot, draftPath);
		if (
			actions.some((action) =>
				discovered(action).some((target) => target.sourcePath === draftPath),
			)
		)
			continue;
		findings.push({
			check: "undiscovered",
			message: `${relative}: no ${[...new Set(actions)].join("/")} target resolves from this draft`,
			subject: relative,
		});
	}

	// Every drafted target of every action is compiled; the observability check
	// and the start apply to the run targets, which are what a run of the app
	// executes.
	const draftedTargets = [...targetsByAction.values()]
		.flat()
		.filter((target) => draftedPaths.has(target.sourcePath));
	const draftedRunTargets = draftedTargets.filter(
		(target) => target.action === "run",
	);
	const otel: Array<{ target: string; ok: boolean }> = [];
	for (const target of draftedRunTargets) {
		let text: string | undefined = draftTexts.get(
			relativeOfDraft(sourceRoot, target.sourcePath),
		);
		if (text === undefined) {
			try {
				text = fs.readFileSync(target.sourcePath, "utf8");
			} catch {
				text = undefined;
			}
		}
		const wired = text !== undefined && referencesOtelVariables(text);
		otel.push({ target: target.id, ok: wired });
		if (!wired)
			findings.push({
				check: "otel",
				message: `${relativeOfDraft(sourceRoot, target.sourcePath)}: the drafted target does not reference any AC_OTEL_* variable`,
				subject: target.id,
			});
	}

	const collisions = detectPortCollisions(
		context.draftsDir,
		draftTexts,
		context.otherAppPorts?.() ?? new Map(),
	);
	for (const collision of collisions)
		findings.push({
			check: "port-collision",
			message: collision,
		});

	const variables = setupVariables(
		draftTexts,
		context.envFileVariables?.() ??
			loadEnvFile(path.join(context.configDir, ".env")),
		context.processEnv ?? process.env,
	);
	for (const name of variables.missing)
		findings.push({
			check: "missing-variable",
			message: `${name} is referenced by the drafts but is not set in the configuration .env`,
		});

	// --- the real developer path --------------------------------------------
	// Discover → compile → the default build → start with readiness → the default
	// test. Every step is reported, and a step the machine cannot run is a
	// `skipped` finding the developer sees, never a pass.
	const byAction = (action: AppAction): ActionTarget[] => discovered(action);
	// The per-app default declaration, read from the staged root: a drafted
	// declaration is what the author validated and what the promotion publishes,
	// so it decides here exactly as it will live afterwards
	// (`fix-default-target-after-promotion`).
	const declarationPath = defaultDeclarationPath(sourceRoot, context.appIdent);
	const declaration: DefaultDeclaration = readDefaultDeclaration(
		context.configDir,
		context.appIdent,
		sourceRoot,
	);
	const declarationRelative = defaultDeclarationRelative(context.appIdent);
	for (const problem of declaration.problems)
		findings.push({
			check: "default-declaration",
			message: problem,
			subject: declarationRelative,
		});
	// What each action's default was resolved to, so the real path below (build,
	// start, test) runs *these* targets and not a second guess.
	const resolvedDefaults = new Map<AppAction, ActionTarget>();
	for (const action of ["build", "run", "test"] as AppAction[]) {
		const seen = byAction(action);
		steps.push({
			step: "discover",
			action,
			targetId: "",
			status: seen.length > 0 ? "ok" : "skipped",
			durationMs: 0,
			targetsSeen: seen.map((target) => target.id),
			...(seen.length === 0
				? { detail: `the app declares no ${action} target` }
				: {}),
		});
		const declared = declaration.actions[action];
		if (action === "run") {
			// A run target is resolved by runtime precedence (`selectTarget`): an app
			// with a compose file and a script target that the developer starts fine
			// must not fail the gate, so no ambiguity is raised for `run` — the
			// resolved default is reported with its reason instead. A declaration
			// still wins.
			const resolved = resolveDefaultTarget({
				configDir: context.configDir,
				configOverlay: sourceRoot,
				appIdent: context.appIdent,
				action,
				targets: seen,
				declaration,
				declarationPath,
			});
			if (resolved.targetObject) {
				resolvedDefaults.set(action, resolved.targetObject);
				defaults.push({
					action: "run",
					targetId: resolved.targetObject.id,
					profile: resolved.targetObject.profile ?? "default",
					runtime: resolved.targetObject.runtime,
					source: resolved.source,
					...(resolved.source === "declared" && declared ? { declared } : {}),
				});
			}
		} else {
			const effective = supersededTargets(seen, draftedPaths);
			const superseded = supersededIds(seen, effective);
			const resolved = resolveDefaultTarget({
				configDir: context.configDir,
				configOverlay: sourceRoot,
				appIdent: context.appIdent,
				action,
				targets: effective,
				declaration,
				declarationPath,
			});
			// A declaration that names a live target a draft supersedes disagrees with
			// the draft beside it: publishing it would validate one target and run
			// another, so it is refused instead of half-honoured.
			if (
				declared !== undefined &&
				resolved.source !== "declared" &&
				seen.some(
					(target) => target.id === declared || target.runtime === declared,
				)
			)
				findings.push({
					check: "default-declaration",
					message: `${declarationRelative} declares ${JSON.stringify(declared)} as the default ${action}, but the draft supersedes it (${superseded.join(", ")}); declare the drafted target instead`,
					subject: declarationRelative,
				});
			if (resolved.ambiguous)
				findings.push({
					check: "no-default-target",
					message: `${context.appIdent} declares several default-profile ${action} targets (${resolved.candidates
						.map((candidate) => candidate.id)
						.join(", ")}); ${resolved.reason}`,
				});
			else if (resolved.targetObject) {
				resolvedDefaults.set(action, resolved.targetObject);
				defaults.push({
					action: action as "build" | "run" | "test",
					targetId: resolved.targetObject.id,
					profile: resolved.targetObject.profile ?? "default",
					runtime: resolved.targetObject.runtime,
					source: resolved.source,
					...(resolved.source === "declared" && declared ? { declared } : {}),
					...(superseded.length > 0 ? { superseded } : {}),
				});
			}
		}
	}

	const compiler = context.compileTarget ?? (() => Promise.resolve());
	for (const target of draftedTargets) {
		const startedAt = Date.now();
		try {
			const bounded = await boundedStep(compiler(target), timeouts.compileMs);
			if (bounded.timedOut)
				throw new Error(
					`the compile exceeded its ${Math.round(timeouts.compileMs / 60000)} min deadline and was stopped`,
				);
			steps.push({
				step: "compile",
				action: target.action,
				targetId: target.id,
				status: "ok",
				durationMs: Date.now() - startedAt,
			});
		} catch (error) {
			findings.push({
				check: "compile",
				message: `${target.id}: ${message(error)}`,
				subject: target.id,
			});
			steps.push({
				step: "compile",
				action: target.action,
				targetId: target.id,
				status: "failed",
				durationMs: Date.now() - startedAt,
				detail: message(error),
			});
		}
	}

	const runTargets = discovered("run");
	// The default run target is always part of the real path: an app whose run
	// target is a script must not be silently dropped from the gate just because
	// only its build/test definitions were drafted. It is the resolved default
	// (declaration first), the same target the smoke check will start live.
	const defaultRun = resolvedDefaults.get("run");
	const reports: SetupValidationTargetReport[] = [];
	/** Records a step the whole-gate budget prevented from running at all. */
	const budgetExhausted = (
		step: string,
		action: string,
		targetId: string,
	): void => {
		steps.push({
			step,
			action,
			targetId,
			status: "skipped",
			durationMs: 0,
			detail: `the gate's wall-clock budget (${Math.round(timeouts.budgetMs / 60000)} min) was spent before this step`,
		});
		findings.push({
			check: "skipped",
			message: `${targetId || action}: the ${step} was not run (the gate's wall-clock budget was spent before this step)`,
			subject: targetId || undefined,
		});
	};
	const runStep = async (
		step: "build" | "test",
		target: ActionTarget | undefined,
		runner: SetupTargetRunner | undefined,
	): Promise<void> => {
		if (!target) {
			steps.push({
				step,
				action: step,
				targetId: "",
				status: "skipped",
				durationMs: 0,
				detail:
					step === "test"
						? "the app declares no test target"
						: "the app declares no build target",
			});
			if (step === "test")
				findings.push({
					check: "no-test-target",
					message: `${context.appIdent} declares no test target`,
					blocking: false,
				});
			return;
		}
		if (budgetLeft() <= 0) {
			budgetExhausted(step, step, target.id);
			return;
		}
		const startedAt = Date.now();
		if (!runner) {
			steps.push({
				step,
				action: step,
				targetId: target.id,
				status: "skipped",
				durationMs: Date.now() - startedAt,
				detail: `the ${step} was not run (no environment server is attached)`,
			});
			findings.push({
				check: "skipped",
				message: `${target.id}: the ${step} was not run (no environment server is attached)`,
				subject: target.id,
			});
			return;
		}
		const deadline = Math.min(
			step === "build" ? timeouts.buildMs : timeouts.testMs,
			Math.max(1, budgetLeft()),
		);
		let result: SetupTargetRunResult;
		try {
			const bounded = await boundedStep(runner(target), deadline);
			result = bounded.timedOut
				? {
						ok: false,
						skipped: true,
						detail: `the ${step} exceeded its ${Math.round(deadline / 60000)} min deadline and was stopped`,
					}
				: (bounded.value as SetupTargetRunResult);
		} catch (error) {
			result = { ok: false, detail: message(error) };
		}
		const status = result.skipped ? "skipped" : result.ok ? "ok" : "failed";
		steps.push({
			step,
			action: step,
			targetId: target.id,
			status,
			durationMs: Date.now() - startedAt,
			...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
			...(boundedStepLog(result.logTail)
				? { logTail: boundedStepLog(result.logTail) }
				: {}),
			...(result.detail ? { detail: result.detail } : {}),
		});
		if (status === "skipped")
			findings.push({
				check: "skipped",
				message: `${target.id}: the ${step} was not run (${result.detail ?? "the machine cannot run it"})`,
				subject: target.id,
			});
		else if (status === "failed")
			findings.push({
				check: step,
				message: `${target.id} ${step} failed${result.exitCode !== undefined && result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}${result.detail ? `: ${result.detail}` : ""}`,
				subject: target.id,
			});
	};

	// The default build runs first: a draft whose default build fails must never
	// reach the developer's review. It is the *resolved* default (a declaration
	// wins, a superseding draft is the successor), not a second guess over the
	// raw discovered list — which skipped the build entirely whenever two families
	// were live.
	const buildSeen = discovered("build");
	const chosenBuild = resolvedDefaults.get("build");
	if (chosenBuild) await runStep("build", chosenBuild, context.buildTarget);
	else if (buildSeen.length === 0)
		await runStep("build", undefined, context.buildTarget);

	// Every *changed* shared infrastructure definition must at least parse: an
	// infra draft whose paths or includes resolve nowhere must not reach the
	// developer's review as if it were runnable.
	for (const relative of drafts.filter((path) =>
		path.startsWith("infrastructure/compose/"),
	)) {
		const startedAt = Date.now();
		if (!context.parseInfrastructure) {
			steps.push({
				step: "infra",
				action: "infra",
				targetId: relative,
				status: "skipped",
				durationMs: 0,
				detail:
					"the infrastructure definition was not parsed (no docker CLI is available)",
			});
			findings.push({
				check: "skipped",
				message: `${relative}: the infrastructure definition was not parsed (no docker CLI is available)`,
				subject: relative,
			});
			continue;
		}
		const bounded = await boundedStep(
			context.parseInfrastructure(relative),
			timeouts.infraMs,
		);
		const parsed = bounded.timedOut
			? {
					ok: false,
					skipped: true,
					detail: `parsing exceeded its ${Math.round(timeouts.infraMs / 60000)} min deadline`,
				}
			: (bounded.value as {
					ok: boolean;
					skipped?: boolean;
					exitCode?: number | null;
					detail?: string;
					logTail?: string;
				});
		const status = parsed.skipped ? "skipped" : parsed.ok ? "ok" : "failed";
		steps.push({
			step: "infra",
			action: "infra",
			targetId: relative,
			status,
			durationMs: Date.now() - startedAt,
			...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
			...(boundedStepLog(parsed.logTail)
				? { logTail: boundedStepLog(parsed.logTail) }
				: {}),
			...(parsed.detail ? { detail: parsed.detail } : {}),
		});
		if (status !== "ok")
			findings.push({
				check: status === "skipped" ? "skipped" : "infra",
				message: `${relative}: the infrastructure definition ${status === "skipped" ? "was not parsed" : "does not parse"}${parsed.detail ? ` (${parsed.detail})` : ""}`,
				subject: relative,
			});
	}

	// One probe per cluster context, not per target: every target naming the
	// same context has the same answer, and the probe is a subprocess.
	const clusterAvailability = new Map<string, boolean>();
	const clusterReachable = (target: ActionTarget): boolean => {
		const contextName = target.kubernetes?.contextName ?? "";
		if (contextName === "") return false;
		const known = clusterAvailability.get(contextName);
		if (known !== undefined) return known;
		const reachable = context.clusterAvailable
			? context.clusterAvailable(target)
			: true;
		clusterAvailability.set(contextName, reachable);
		return reachable;
	};

	for (const target of runTargets) {
		const drafted = draftedPaths.has(target.sourcePath);
		const docker = target.runtime === "docker";
		const isDefaultRun = target.id === defaultRun?.id;
		if (!drafted && !docker && !isDefaultRun) continue;
		if (target.runtime === "kubernetes" && !drafted && !isDefaultRun) continue;
		if (target.runtime === "kubernetes" && !clusterReachable(target)) {
			reports.push({
				id: target.id,
				runtime: target.runtime,
				profile: target.profile ?? "",
				sourcePath: target.sourcePath,
				drafted,
				started: "skipped",
				detail: "the Kubernetes cluster is not reachable",
			});
			steps.push({
				step: "start",
				action: "run",
				targetId: target.id,
				status: "skipped",
				durationMs: 0,
				detail: "the Kubernetes cluster is not reachable",
			});
			// A start the machine cannot run is a finding the developer sees, never
			// a pass: a target that never started must not be promoted as validated.
			findings.push({
				check: "skipped",
				message: `${target.id}: the start was not run (the Kubernetes cluster ${target.kubernetes?.contextName ?? ""} is not reachable)`,
				subject: target.id,
			});
			continue;
		}
		// A target that resolves from a non-regular draft is never run: what the
		// approval gate shows and the promotion publishes is plain files only.
		if (
			target.action === "run" &&
			nonRegularDrafts.has(relativeOfDraft(sourceRoot, target.sourcePath))
		) {
			reports.push({
				id: target.id,
				runtime: target.runtime,
				profile: target.profile ?? "",
				sourcePath: target.sourcePath,
				drafted,
				started: "skipped",
				detail: "the draft is not a plain file",
			});
			steps.push({
				step: "start",
				action: "run",
				targetId: target.id,
				status: "skipped",
				durationMs: 0,
				detail: "the draft is not a plain file",
			});
			continue;
		}
		const startedAt = Date.now();
		let started: SetupTargetStartResult;
		try {
			const bounded = await boundedStep(
				context.startTarget(target),
				Math.min(timeouts.startMs, Math.max(1, budgetLeft())),
			);
			started = bounded.timedOut
				? {
						ready: false,
						detail: `the start exceeded its ${Math.round(timeouts.startMs / 60000)} min deadline and was stopped`,
					}
				: (bounded.value as SetupTargetStartResult);
		} catch (error) {
			started = { ready: false, detail: message(error) };
		}
		reports.push({
			id: target.id,
			runtime: target.runtime,
			profile: target.profile ?? "",
			sourcePath: target.sourcePath,
			drafted,
			started: started.ready ? "ready" : "failed",
			...(started.detail ? { detail: started.detail } : {}),
		});
		steps.push({
			step: "start",
			action: "run",
			targetId: target.id,
			status: started.ready ? "ok" : "failed",
			durationMs: Date.now() - startedAt,
			...(started.detail ? { detail: started.detail } : {}),
		});
		if (!started.ready)
			findings.push({
				check: "start",
				message: `${target.id} did not reach readiness${started.detail ? `: ${started.detail}` : ""}`,
				subject: target.id,
			});
	}

	// The default test runs once, after the app is up: a test target that exists
	// and fails is a finding, and an app with no test target is stated.
	const testSeen = discovered("test");
	{
		const chosen = resolvedDefaults.get("test");
		if (chosen) await runStep("test", chosen, context.testTarget);
		else if (testSeen.length === 0)
			await runStep("test", undefined, context.testTarget);
	}

	// The app the gate started is released again unless the workflow keeps it:
	// the gate is a check, not a hold.
	if (context.releaseTarget)
		try {
			await context.releaseTarget();
		} catch {
			// A release that fails is the slot controller's business, not a finding
			// that changes whether the draft is valid.
		}

	const blocking = findings.filter((finding) => finding.blocking !== false);
	return report({
		ok:
			blocking.length === 0 &&
			reports.every((entry) => entry.started !== "failed") &&
			steps.every((entry) => entry.status !== "failed"),
		app: context.appIdent,
		drafts,
		targets: reports,
		findings,
		variables,
		otel,
	});
}

/** The variables the drafts reference and the ones the environment lacks. */
export function setupVariables(
	draftTexts: ReadonlyMap<string, string>,
	envFile: ReadonlyMap<string, string>,
	processEnv: Record<string, string | undefined>,
): { used: string[]; missing: string[] } {
	const used = new Set<string>();
	for (const text of draftTexts.values())
		for (const name of referencedVariables(text)) used.add(name);
	const sorted = [...used].sort();
	return {
		used: sorted,
		missing: sorted.filter(
			(name) =>
				!envFile.has(name) &&
				(processEnv[name] === undefined || processEnv[name] === ""),
		),
	};
}

/** `${VAR}` references, in declaration order and deduplicated. */
export function referencedVariables(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g)) {
		const name = match[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Whether a drafted definition wires the app to the injected OTel variables. */
export function referencesOtelVariables(text: string): boolean {
	return /AC_OTEL_[A-Z0-9_]+/.test(text);
}

/**
 * Host ports a drafted target publishes, compared with the ports the other
 * apps already declare. A collision names both sides, so the author can move
 * its port instead of guessing.
 */
export function detectPortCollisions(
	draftsDir: string,
	draftTexts: ReadonlyMap<string, string>,
	otherPorts: ReadonlyMap<number, string>,
): string[] {
	const findings: string[] = [];
	if (otherPorts.size === 0) return findings;
	for (const [relative, text] of draftTexts) {
		const drafted = isComposePath(relative)
			? composeHostPorts(text)
			: relative.endsWith(".k8s.json")
				? kubernetesHostPorts(text)
				: [];
		for (const port of drafted) {
			const owner = otherPorts.get(port);
			if (!owner) continue;
			findings.push(
				`${relative}: host port ${port} is already declared by ${owner}`,
			);
		}
	}
	// Kept for signature symmetry with the drafts root: a caller may report the
	// drafts directory in the message.
	void draftsDir;
	return findings;
}

function isComposePath(relative: string): boolean {
	if (
		!relative.startsWith("apps/compose/") &&
		!relative.startsWith("infrastructure/compose/")
	)
		return false;
	return relative.endsWith(".yml") || relative.endsWith(".yaml");
}

/** Host ports published by a compose file's `ports:` lists. */
export function composeHostPorts(text: string): number[] {
	const ports: number[] = [];
	const lines = text.split("\n");
	let listIndent: number | undefined;
	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (listIndent !== undefined) {
			if (indent < listIndent) {
				listIndent = undefined;
			} else if (trimmed.startsWith("- ")) {
				const value = trimmed.slice(2).trim();
				const long = longSyntaxKey(value);
				if (long !== undefined) ports.push(long);
				else {
					const parsed = shortSyntaxPort(value);
					if (parsed !== undefined) ports.push(parsed);
				}
				continue;
			} else {
				const published = longSyntaxKey(trimmed);
				if (published !== undefined) ports.push(published);
				continue;
			}
		}
		if (/^ports\s*:\s*$/.test(trimmed)) listIndent = indent + 1;
	}
	return ports;
}

function longSyntaxKey(value: string): number | undefined {
	if (!value.startsWith("published")) return undefined;
	const raw = value.slice("published".length).replace(/^:/, "").trim();
	return firstPortNumber(raw);
}

function shortSyntaxPort(value: string): number | undefined {
	const unquoted = value.replace(/^["']|["']$/g, "");
	const withoutProtocol = unquoted.split("/")[0] ?? unquoted;
	const segments = withoutProtocol.split(":");
	if (segments.length < 2) return undefined;
	// `[HOST_IP:]PUBLISHED:TARGET` — the published port is the second to last.
	return firstPortNumber(segments[segments.length - 2] ?? "");
}

function firstPortNumber(value: string): number | undefined {
	const unquoted = value.trim().replace(/^["']|["']$/g, "");
	const match = unquoted.match(/^(\d{1,5})(?:-\d{1,5})?$/);
	if (!match) return undefined;
	const port = Number(match[1]);
	return port >= 1 && port <= 65535 ? port : undefined;
}

/** Host ports a Kubernetes run config forwards locally. */
export function kubernetesHostPorts(text: string): number[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const ports: number[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "localPort" && typeof child === "number") ports.push(child);
			else visit(child);
		}
	};
	visit(parsed);
	return ports;
}

/**
 * Host ports the other apps already declare: every live compose file's
 * published ports and every live Kubernetes run config's forwarded ports,
 * excluding the app being set up. Ownership is decided by the file-name prefix
 * of a *configured* app ident — never by truncating the name at a hyphen, which
 * would both report the app's own definitions as another app's and mask a real
 * collision between an ident and a longer one that starts with it.
 */
export function declaredAppPorts(
	configDir: string,
	excludeApp: string,
): Map<number, string> {
	const ports = new Map<number, string>();
	const claim = (port: number, owner: string): void => {
		if (!ports.has(port)) ports.set(port, owner);
	};
	const idents = configuredAppIdents(configDir);
	const ownedBy = (name: string): string | undefined => {
		let best: string | undefined;
		for (const ident of idents) {
			if (!name.startsWith(`${ident}-`)) continue;
			if (best === undefined || ident.length > best.length) best = ident;
		}
		return best;
	};
	// The app under setup is excluded by the ident its file resolves to: a file
	// owned by a longer, different ident (`installer` vs `installer-fe`) stays in
	// the map, so a real collision cannot hide behind the prefix. The raw prefix
	// remains the fallback for an app with no definition file to resolve.
	const isOwn = (name: string): boolean => {
		if (excludeApp === "") return false;
		const owner = ownedBy(name);
		if (owner !== undefined) return owner === excludeApp;
		return name.startsWith(`${excludeApp}-`);
	};
	for (const { name, path: filePath } of configDirEntries(
		{ configDir },
		"apps",
		"compose",
	)) {
		if (isOwn(name)) continue;
		const app = ownedBy(name) ?? appIdentOfComposeFile(name);
		if (!app) continue;
		for (const port of composeHostPorts(readText(filePath)))
			claim(port, `${app} (${name})`);
	}
	for (const { name, path: filePath } of configDirEntries(
		{ configDir },
		"apps",
		"kubernetes",
	)) {
		if (!name.endsWith(".k8s.json")) continue;
		if (isOwn(name)) continue;
		const app = ownedBy(name);
		if (!app) continue;
		for (const port of kubernetesHostPorts(readText(filePath)))
			claim(port, `${app} (${name})`);
	}
	return ports;
}

/** The configured app idents, from the app definition file names. */
export function configuredAppIdents(configDir: string): string[] {
	const idents: string[] = [];
	for (const { name } of configDirEntries(
		{ configDir },
		"apps",
		"definitions",
	)) {
		if (!name.endsWith(".json")) continue;
		const ident = name.slice(0, name.length - ".json".length);
		if (ident !== "") idents.push(ident);
	}
	return idents.sort();
}

function appIdentOfComposeFile(name: string): string | undefined {
	for (const suffix of ["-compose.yml", "-compose.yaml"]) {
		if (!name.endsWith(suffix)) continue;
		const head = name.slice(0, name.length - suffix.length);
		return head === "" ? undefined : head;
	}
	return undefined;
}

function readText(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

/**
 * Whether a Kubernetes context is reachable, used for the k8s start rule. The
 * probe is bounded: an unreachable API server answers "not reachable" after the
 * timeout instead of blocking the process running the effect.
 */
export function kubernetesClusterAvailable(context: string): boolean {
	if (context === "") return false;
	const result = Bun.spawnSync(
		["kubectl", "--context", context, "version", "--output=json"],
		{
			stdout: "ignore",
			stderr: "ignore",
			timeout: KUBERNETES_PROBE_TIMEOUT_MS,
		},
	);
	return result.exitCode === 0;
}

/**
 * The real compiler: the registry's own compilers over the drafted targets, so
 * a draft that cannot compile is refused before a developer is asked to
 * approve it. The tool probe is resolved once per compiler instance — every
 * target of one validation round compiles against the same tool snapshot, as
 * the action routes do.
 */
export function defaultSetupTargetCompiler(options: {
	readonly appIdent: string;
	readonly checkoutDir: string;
	readonly configDir: string;
	readonly tempDir?: string;
}): SetupTargetCompiler {
	let toolsPromise: ReturnType<typeof checkToolAvailability> | undefined;
	return async (target) => {
		if (!toolsPromise) toolsPromise = checkToolAvailability();
		const tools = await toolsPromise;
		compileContainerTargetsWithTools(
			options.appIdent,
			target,
			undefined,
			tools,
			{
				checkoutDir: options.checkoutDir,
				configDir: options.configDir,
				tempDir: options.tempDir ?? "",
			},
		);
	};
}

/** The config-relative path of an absolute draft path. */
export function relativeOfDraft(draftsDir: string, draftPath: string): string {
	const relative = path.relative(draftsDir, draftPath);
	return relative.split(path.sep).join("/");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
