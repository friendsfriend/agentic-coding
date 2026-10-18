// The single source of truth for "which target is the default for one app and
// action" (`fix-default-target-after-promotion`).
//
// The motivating defect: after an `env-setup` promotion two live default-profile
// build targets existed for one app (a symlinked `apps/build/<app>-build.Dockerfile`
// and the promoted `apps/build/<app>-build.sh`), the validation gate had
// validated the shell one, and the Environments UI built the docker one — three
// consumers, three answers. "A drafted target supersedes the live one" existed
// only inside a staged view, and a live resolution fell back to a runtime-preference
// guess.
//
// Every consumer now asks this module: the agent `env_build`/`env_test`
// resolver, `env_list`, the developer's UI/TUI build/run/test action (through the
// `default` marking the actions route puts on the definitions it returns), the
// validation gate and the post-promotion smoke check.
//
// The rules, in order:
//
//   1. A per-app default declaration — `<config>/apps/defaults/<app>.json` —
//      names the target ("build": "app/<app>/build/shell"). A declaration is the
//      only *durable* statement that survives a promotion and the only way to
//      keep a choice once the staged view is gone. It wins whenever it resolves.
//   2. Otherwise, if every default-profile candidate belongs to *one* runtime
//      family (container / script / kubernetes), that family's rendering first in
//      the platform's preference order is the default: there is no choice to make.
//   3. Otherwise several families are live:
//        - a `run` resolves by the platform's documented runtime preference
//          (Docker, then a script, then Kubernetes — the order `selectTarget`
//          applies), reported as `preference` so the developer sees *why*;
//        - a `build`/`test` is **ambiguous**: no rule may guess. Non-interactive
//          consumers fail with the candidate list and how to resolve it, and
//          interactive ones refuse or ask instead of preselecting.
import fs from "node:fs";
import path from "node:path";
import { configDirEntries, discoverActionTargets } from "./discovery.ts";
import type { ActionTarget, AppAction } from "./targets.ts";

/** Configuration-relative directory the per-app default declarations live in. */
export const DEFAULT_DECLARATIONS_DIR = "apps/defaults";

/** The configuration-relative declaration path of one app. */
export function defaultDeclarationRelative(appIdent: string): string {
	return `${DEFAULT_DECLARATIONS_DIR}/${appIdent}.json`;
}

/** The absolute declaration path of one app. */
export function defaultDeclarationPath(
	configDir: string,
	appIdent: string,
): string {
	return path.join(configDir, DEFAULT_DECLARATIONS_DIR, `${appIdent}.json`);
}

/** The actions a declaration may name. */
export const DECLARABLE_ACTIONS: readonly AppAction[] = [
	"build",
	"test",
	"run",
];

/** How a default target was decided, so every surface can say why. */
export type DefaultSource =
	/** Named by `<config>/apps/defaults/<app>.json`. */
	| "declared"
	/** The only default-profile candidate family: nothing was chosen. */
	| "only-candidate"
	/** Several families were live and the platform's preference decided. */
	| "preference";

/** The runtime preference for an interactive `run` (Docker first, then a
 * script, then Kubernetes), matching `SYNCHRONOUS_RUNTIME_PREFERENCE`'s sibling
 * in the runtime adapter and `selectTarget`'s own order. */
export const RUN_RUNTIME_PREFERENCE: readonly string[] = [
	"docker",
	"shell",
	"podman",
	"systemshell",
	"tmux",
	"command-shell",
	"command-powershell",
	"kubernetes",
];

/** `build`/`test` run synchronously: the plain command rendering is the
 * default, not the `tmux` window one. */
export const SYNCHRONOUS_RUNTIME_PREFERENCE: readonly string[] = [
	"docker",
	"shell",
	"podman",
	"systemshell",
	"command-shell",
	"command-powershell",
	"tmux",
	"kubernetes",
];

/** The preference order one action resolves a same-family tie with. */
export function runtimePreferenceFor(action: AppAction): readonly string[] {
	return action === "run"
		? RUN_RUNTIME_PREFERENCE
		: SYNCHRONOUS_RUNTIME_PREFERENCE;
}

/**
 * The runtime *family* of a target: the renderings of one definition are one
 * choice, never an ambiguity. A shell target compiles into a `tmux` variant
 * beside its plain `command-shell` one and a docker target into a `podman`
 * dialect when podman is present, so a naive "every id ending in `/default`"
 * would make every script app ambiguous.
 */
export function runtimeFamily(runtime: string): string {
	const value = runtime ?? "";
	if (value === "docker" || value === "podman") return "container";
	if (value.startsWith("tmux") || value.startsWith("command")) return "script";
	if (value === "kubernetes") return "kubernetes";
	return value;
}

/** One candidate the default could be chosen from. */
export interface DefaultCandidate {
	/** The identifier a declaration is matched against: the client-visible target
	 * id for a discovered target, the compiled definition id for a definition
	 * row. */
	readonly id: string;
	/** The discovered target's own id, so a declaration written as
	 * `app/<app>/build/<runtime>` resolves wherever the candidate came from. */
	readonly targetId?: string;
	readonly action: AppAction;
	readonly runtime: string;
	readonly profile?: string;
	readonly label?: string;
	/** The compiled definition id, when the candidate came from a definition. */
	readonly definitionId?: string;
	/** Whether this candidate is available right now, when the caller knows. */
	readonly available?: boolean;
}

/** The parsed declarations of one app. */
export interface DefaultDeclaration {
	/** Action -> the target the developer declared as its default. */
	readonly actions: Partial<Record<AppAction, string>>;
	/** Structural problems an author must fix (unknown key, empty value). */
	readonly problems: string[];
}

const NO_DECLARATION: DefaultDeclaration = { actions: {}, problems: [] };

/**
 * Read one app's declaration file. A missing file is the empty declaration (the
 * common case); a malformed one is a problem the gate refuses, never a crash.
 */
export function readDefaultDeclaration(
	configDir: string,
	appIdent: string,
	/** A second configuration root whose declaration shadows `configDir`'s (the
	 * `env-setup` staged root): a drafted declaration is the one the author
	 * validated, so it is read first when it exists. */
	overlay?: string,
): DefaultDeclaration {
	if (appIdent === "") return NO_DECLARATION;
	const roots = overlay ? [overlay, configDir] : [configDir];
	for (const root of roots) {
		if (root === "") continue;
		const filePath = defaultDeclarationPath(root, appIdent);
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		return parseDefaultDeclaration(text, defaultDeclarationRelative(appIdent));
	}
	return NO_DECLARATION;
}

/** Parse one declaration document. Exported so the gate can validate a draft
 * without it having reached the live configuration. */
export function parseDefaultDeclaration(
	text: string,
	relative: string,
): DefaultDeclaration {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			actions: {},
			problems: [
				`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
			],
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			actions: {},
			problems: [
				`${relative}: a default declaration is a JSON object mapping an action (${DECLARABLE_ACTIONS.join(", ")}) to a target id`,
			],
		};
	}
	const actions: Partial<Record<AppAction, string>> = {};
	const problems: string[] = [];
	for (const [key, value] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (!(DECLARABLE_ACTIONS as readonly string[]).includes(key)) {
			problems.push(
				`${relative}: ${JSON.stringify(key)} is not an action; declare one of ${DECLARABLE_ACTIONS.join(", ")}`,
			);
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(
				`${relative}: ${key} must name a target (its id, a runtime such as docker or shell, or its label)`,
			);
			continue;
		}
		actions[key as AppAction] = value.trim();
	}
	return { actions, problems };
}

/** Whether a candidate is a default-profile candidate. */
function isDefaultProfile(candidate: DefaultCandidate): boolean {
	const profile = candidate.profile ?? "";
	return (
		profile === "" ||
		profile === "default" ||
		candidate.id.endsWith("/default") ||
		(candidate.definitionId ?? "").endsWith("/default")
	);
}

/** Whether a declaration names this candidate. */
export function declarationMatches(
	declared: string,
	candidate: DefaultCandidate,
): boolean {
	const wanted = declared.trim();
	if (wanted === "") return false;
	return (
		candidate.id === wanted ||
		candidate.targetId === wanted ||
		candidate.definitionId === wanted ||
		candidate.runtime === wanted ||
		runtimeFamily(candidate.runtime) === wanted ||
		(candidate.label ?? "") === wanted
	);
}

/** The decision for one app and action. */
export interface DefaultDecision {
	readonly action: AppAction;
	/** The resolved default; absent when several families are live and nothing
	 * declares which one wins (`ambiguous`). */
	readonly target?: DefaultCandidate;
	readonly source: DefaultSource;
	/** The declaration that decided it, when one did. */
	readonly declared?: string;
	/** The default-profile candidates of more than one family. */
	readonly candidates: DefaultCandidate[];
	readonly ambiguous: boolean;
	/** One sentence a surface can render verbatim: which target, and why. */
	readonly reason: string;
}

/** Resolve the default for one action from a candidate list. Never guesses
 * between two runtime families of a synchronous action. */
export function decideDefaultTarget(options: {
	readonly action: AppAction;
	readonly candidates: readonly DefaultCandidate[];
	readonly declared?: string;
	readonly declarationPath?: string;
	/** A `run` may fall back to the platform's documented runtime preference;
	 * a `build`/`test` never does. */
	readonly allowRunPreference?: boolean;
}): DefaultDecision {
	const { action } = options;
	const all = [...options.candidates].sort((a, b) => (a.id < b.id ? -1 : 1));
	const preferredProfile = all.filter(isDefaultProfile);
	const considered = preferredProfile.length > 0 ? preferredProfile : all;
	const preference = runtimePreferenceFor(action);
	const declared = (options.declared ?? "").trim();
	const where =
		options.declarationPath ?? `${DEFAULT_DECLARATIONS_DIR}/<app>.json`;

	if (declared !== "") {
		const named =
			considered.find((candidate) => declarationMatches(declared, candidate)) ??
			all.find((candidate) => declarationMatches(declared, candidate));
		if (named) {
			return {
				action,
				target: named,
				source: "declared",
				declared,
				candidates: familyPeers(considered, named),
				ambiguous: false,
				reason: `declared in ${where}: ${named.id}`,
			};
		}
		return {
			action,
			source: "declared",
			declared,
			candidates: considered.map((candidate) => candidate),
			ambiguous: true,
			reason: `${where} declares ${JSON.stringify(declared)}, which is not a ${action} target of this app (${
				considered.map((candidate) => candidate.id).join(", ") || "none"
			}); fix the declaration or the target it names`,
		};
	}

	if (considered.length === 0)
		return {
			action,
			source: "only-candidate",
			candidates: [],
			ambiguous: false,
			reason: `the app declares no ${action} target`,
		};

	const families = new Set(
		considered.map((candidate) => runtimeFamily(candidate.runtime)),
	);
	const ranked = [...considered].sort(
		(a, b) => rank(preference, a.runtime) - rank(preference, b.runtime),
	);
	const first = ranked[0] as DefaultCandidate;
	if (families.size === 1) {
		const sources = new Set(considered.map((candidate) => candidate.runtime));
		return {
			action,
			target: first,
			source: sources.size === 1 ? "only-candidate" : "preference",
			candidates: considered,
			ambiguous: false,
			reason:
				sources.size === 1
					? `the only default-profile ${action} candidate (${first.runtime})`
					: `one runtime family, first in the platform preference order: ${first.runtime}`,
		};
	}
	if (action === "run" && options.allowRunPreference !== false) {
		return {
			action,
			target: first,
			source: "preference",
			candidates: considered,
			ambiguous: false,
			reason: `the platform's run preference (${preference.slice(0, 2).join(" before ")}): ${first.runtime}; declare one in ${where} to choose another`,
		};
	}
	return {
		action,
		source: "preference",
		candidates: considered,
		ambiguous: true,
		reason: `${considered
			.map((candidate) => candidate.id)
			.join(
				", ",
			)} are default-profile ${action} candidates of different runtime families; declare the default in ${where} (for example {"${action}": "${first.id}"})`,
	};
}

/** The candidates of the chosen family (the renderings of one choice). */
function familyPeers(
	considered: readonly DefaultCandidate[],
	chosen: DefaultCandidate,
): DefaultCandidate[] {
	const family = runtimeFamily(chosen.runtime);
	return considered.filter(
		(candidate) => runtimeFamily(candidate.runtime) === family,
	);
}

function rank(preference: readonly string[], runtime: string): number {
	const index = preference.indexOf(runtime);
	return index === -1 ? 99 : index;
}

/** A candidate list built from discovered targets. */
export function candidatesOfTargets(
	targets: readonly ActionTarget[],
): DefaultCandidate[] {
	return targets.map((target) => ({
		id: target.id,
		targetId: target.id,
		action: target.action,
		runtime: target.runtime,
		...(target.profile ? { profile: target.profile } : {}),
		label: target.label,
	}));
}

/** Resolve the default of one action over discovered targets. */
export function resolveDefaultTarget(options: {
	readonly configDir: string;
	readonly appIdent: string;
	readonly action: AppAction;
	readonly targets: readonly ActionTarget[];
	/** An already-read/parsed declaration, so a caller that validated a draft
	 * does not re-read the file. */
	readonly declaration?: DefaultDeclaration;
	/** A second configuration root whose declaration shadows `configDir`'s (the
	 * `env-setup` staged root). */
	readonly configOverlay?: string;
	/** The declaration path to name in the reason (a draft's own path). */
	readonly declarationPath?: string;
	readonly allowRunPreference?: boolean;
}): DefaultDecision & { readonly targetObject?: ActionTarget } {
	const declaration =
		options.declaration ??
		readDefaultDeclaration(
			options.configDir,
			options.appIdent,
			options.configOverlay,
		);
	const decision = decideDefaultTarget({
		action: options.action,
		candidates: candidatesOfTargets(options.targets),
		...(declaration.actions[options.action] !== undefined
			? { declared: declaration.actions[options.action] as string }
			: {}),
		declarationPath:
			options.declarationPath ?? defaultDeclarationRelative(options.appIdent),
		...(options.allowRunPreference === undefined
			? {}
			: { allowRunPreference: options.allowRunPreference }),
	});
	if (!decision.target) return decision;
	const targetObject = options.targets.find(
		(target) => target.id === decision.target?.id,
	);
	return { ...decision, ...(targetObject ? { targetObject } : {}) };
}

/** The live defaults of every action an app declares, resolved through the same
 * rule the UI and the agent tools use. `resolveLiveDefaults` re-discovers the
 * configuration itself; `resolveSetupDefaults` is the post-promotion smoke
 * check's entry point and is exported so a test can drive it without a server. */
export interface LiveDefaults {
	readonly build?: DefaultDecision;
	readonly test?: DefaultDecision;
	readonly run?: DefaultDecision;
}

export function resolveLiveDefaults(options: {
	readonly configDir: string;
	readonly appIdent: string;
	readonly checkoutDir: string;
	readonly actions?: readonly AppAction[];
	readonly platform?: string;
}): LiveDefaults {
	const declaration = readDefaultDeclaration(
		options.configDir,
		options.appIdent,
	);
	const actions = options.actions ?? DECLARABLE_ACTIONS;
	const out: Record<string, DefaultDecision> = {};
	for (const action of actions) {
		let targets: ActionTarget[] = [];
		try {
			targets = discoverActionTargets({
				appIdent: options.appIdent,
				localDir: options.checkoutDir,
				action,
				configDir: options.configDir,
				...(options.platform ? { platform: options.platform } : {}),
			});
		} catch {
			// A configuration whose discovery throws is reported by the caller as
			// "no default"; the smoke check must not crash on it.
			targets = [];
		}
		out[action] = resolveDefaultTarget({
			configDir: options.configDir,
			appIdent: options.appIdent,
			action,
			targets,
			declaration,
		});
	}
	return out as LiveDefaults;
}

/** One action whose live default is not the one the gate validated. */
export interface DefaultDrift {
	readonly action: AppAction;
	readonly validated: string;
	readonly live?: string;
	readonly reason: string;
}

/**
 * Compare what the gate validated with what the live configuration resolves to
 * now. A live default that is missing (the promoted declaration did not land, or
 * two families are live with nothing declared) is drift, not a pass: the smoke
 * check then fails and the developer is offered the rollback.
 */
export function compareSetupDefaults(
	validated: Readonly<Record<string, string>> | undefined,
	live: LiveDefaults,
): { readonly ok: boolean; readonly drift: DefaultDrift[] } {
	const drift: DefaultDrift[] = [];
	for (const action of DECLARABLE_ACTIONS) {
		const expected = validated?.[action];
		if (expected === undefined || expected === "") continue;
		const decision = live[action];
		const actual = decision?.target?.id;
		if (actual === expected) continue;
		drift.push({
			action,
			validated: expected,
			...(actual ? { live: actual } : {}),
			reason:
				decision?.reason ??
				`the live configuration resolves no default ${action} target`,
		});
	}
	return { ok: drift.length === 0, drift };
}

/** Every default declaration file of a configuration, in path order. Used by
 * the gate's discovery of "what a draft may publish here". */
export function listDefaultDeclarations(
	configDir: string,
): Array<{ readonly app: string; readonly path: string }> {
	return configDirEntries({ configDir }, DEFAULT_DECLARATIONS_DIR)
		.filter((entry) => entry.name.endsWith(".json"))
		.map((entry) => ({
			app: entry.name.slice(0, entry.name.length - ".json".length),
			path: entry.path,
		}))
		.sort((a, b) => (a.app < b.app ? -1 : 1));
}

/** The live targets of one action, discovered from the configuration itself
 * (`localDir` defaults to the configuration root: the Dockerfile, script,
 * compose and Kubernetes conventions all live there). */
export function discoverLiveTargets(
	configDir: string,
	appIdent: string,
	action: AppAction,
	localDir?: string,
	platform?: string,
	configOverlay?: string,
): ActionTarget[] {
	try {
		return discoverActionTargets({
			appIdent,
			localDir: localDir ?? configDir,
			action,
			configDir,
			...(configOverlay ? { configOverlay } : {}),
			...(platform ? { platform } : {}),
		});
	} catch {
		return [];
	}
}

/**
 * The notice an approval diff prints above a drafted default declaration: what
 * it declares and, when the live configuration had several runtime families in
 * play, which ones it had to choose between
 * (`fix-default-target-after-promotion`). The developer reads exactly the choice
 * the promotion is about to make live — "default build for <app> = <target>
 * (was ambiguous: docker, shell)".
 */
export function declarationDiffNotice(options: {
	readonly configDir: string;
	readonly appIdent: string;
	readonly text: string;
	/** The live configuration's own declaration, when the caller already read it. */
	readonly live?: DefaultDeclaration;
	readonly localDir?: string;
}): string {
	if (options.appIdent === "") return "";
	const drafted = parseDefaultDeclaration(
		options.text,
		defaultDeclarationRelative(options.appIdent),
	);
	const live =
		options.live ?? readDefaultDeclaration(options.configDir, options.appIdent);
	const lines: string[] = [];
	for (const action of DECLARABLE_ACTIONS) {
		const declared = drafted.actions[action];
		if (declared === undefined) continue;
		const before = live.actions[action];
		const decision = decideDefaultTarget({
			action,
			candidates: candidatesOfTargets(
				discoverLiveTargets(
					options.configDir,
					options.appIdent,
					action,
					options.localDir,
				),
			),
			...(before !== undefined ? { declared: before } : {}),
			declarationPath: defaultDeclarationRelative(options.appIdent),
		});
		// One representative runtime per family: the developer reads the families
		// the choice was between (docker, shell), not the internal family names.
		const families: string[] = [];
		for (const candidate of decision.candidates) {
			const family = runtimeFamily(candidate.runtime);
			if (families.includes(family)) continue;
			families.push(family);
		}
		const names = families
			.map(
				(family) =>
					decision.candidates.find(
						(candidate) => runtimeFamily(candidate.runtime) === family,
					)?.runtime ?? family,
			)
			.join(", ");
		const ambiguous =
			before === undefined && families.length > 1
				? ` (was ambiguous: ${names})`
				: "";
		const changed =
			before === undefined ? "" : ` (was ${JSON.stringify(before)})`;
		lines.push(
			`# default ${action} for ${options.appIdent} = ${JSON.stringify(declared)}${changed}${ambiguous}`,
		);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The target id a declaration names for an action, resolved against what the
 * configuration really offers — or `undefined` when nothing declares it, so a
 * caller can leave its own documented fallback in place. A declared default of
 * `run` therefore reaches `env_start` (which names the target it starts)
 * instead of being silently replaced by the platform's runtime preference.
 */
export function declaredTargetId(options: {
	readonly configDir: string;
	readonly appIdent: string;
	readonly action: AppAction;
	readonly checkoutDir?: string;
	/** The owner's staged configuration root, when it has one. */
	readonly configOverlay?: string;
}): string | undefined {
	const declaration = readDefaultDeclaration(
		options.configDir,
		options.appIdent,
		options.configOverlay,
	);
	if (declaration.actions[options.action] === undefined) return undefined;
	const decision = resolveDefaultTarget({
		configDir: options.configDir,
		appIdent: options.appIdent,
		action: options.action,
		targets: discoverLiveTargets(
			options.configDir,
			options.appIdent,
			options.action,
			options.checkoutDir,
			undefined,
			options.configOverlay,
		),
		declaration,
	});
	return decision.source === "declared" ? decision.target?.id : undefined;
}
