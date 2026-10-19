// Section item builders for Settings (centralize-application-settings). Pure
// functions: a section page renders the items its builder returns from a
// snapshot the shell resolved, so navigation and activation stay testable
// without a terminal and no builder performs I/O.
//
// Every item states its effective value and the source/scope line it came from;
// an item that cannot be edited here is marked read-only and carries the
// explanation from the inventory instead of pretending to accept an edit.

import type { BrowserStatusResponse } from "../../contracts/browser.ts";
import type { ClassifierStatusResponse } from "../../contracts/gateway.ts";
import type {
	StageIdentitiesResponse,
	StageIdentityStatus,
	StagesStatusResponse,
} from "../../contracts/stages.ts";
import {
	COMPACTION_CEILING_DEFAULT,
	COMPACTION_CEILING_MINIMUM,
	COMPACTION_DEFAULT_TRIGGER_PERCENT,
	COMPACTION_PERCENT_MAX,
	COMPACTION_PERCENT_MIN,
	COMPACTION_TOKEN_CEILING,
	type CompactionCeiling,
	type CompactionFieldError,
	type CompactionTokenField,
	type CompactionTokenValue,
	compactionFieldDefaultForm,
	compactionFieldMinimum,
	parseCompactionPercent,
} from "../../workflow/compaction.ts";
import { DEFAULT_ORCHESTRATOR_MONITOR } from "../../workflow/profiles.ts";
import {
	type Route,
	type SettingsSection,
	settingsRoute,
} from "../shared/routes.ts";
import {
	effectLabel,
	inventoryEntry,
	type SettingsEffect,
	type SettingsScope,
	scopeLabel,
} from "./catalog.ts";
import { lastStageError } from "./stages.ts";

/** What activating an item does. Navigation is returned, never performed. */
export type SettingsAction =
	| { kind: "none" }
	/** Open the shared theme picker (search, live preview, save on selection). */
	| { kind: "theme-picker" }
	/** Re-read the connected server after an unavailable/error state. */
	| { kind: "retry" }
	/** The one download path: ask the server to install Chromium. Nothing is
	 * fetched until this action is activated, and the row says so. */
	| { kind: "browser-install" }
	/** Stop an in-flight browser download. */
	| { kind: "browser-install-cancel" }
	/** Open the bounded numeric editor for one compaction token field
	 * (`add-agent-compaction`): digits, optionally in the field's documented
	 * percentage form, applied only on explicit confirmation. */
	| { kind: "numeric-edit"; field: CompactionTokenField }
	/** Flip the compaction enable switch. */
	| { kind: "compaction-toggle" }
	/** Set one credential the stage catalog references, through the protected
	 * `.env` flow: the value is typed into a masked dialog, written to the
	 * referenced key and never shown again. */
	| { kind: "stage-credential"; variable: string; label: string }
	/** Forget cached sign-ins (`add-stage-identity-cache`): one `(stage, role)`,
	 * every role of one stage (`role` absent), or the whole cache (`stage` absent
	 * too). The row names the scope it drops, and its label counts what the
	 * listing held when it was rendered. A single key is one activation; a
	 * stage-wide or whole-cache scope removes every key at once, so the shell arms
	 * it on the first activation and performs it on a second one on the same row
	 * (`App.tsx`). Dropping an identity only affects the *next* session's silent
	 * reuse — it never logs a live session out. */
	| {
			kind: "stage-identity-forget";
			stage?: string;
			role?: string;
			label: string;
	  }
	| { kind: "navigate"; route: Route };

export interface SettingsItem {
	id: string;
	label: string;
	/** Effective value, or a short state description. */
	value: string;
	/** Source, scope and effect line. */
	detail: string;
	editable: boolean;
	action: SettingsAction;
}

export interface AgentRoutingEntry {
	label: string;
	value: string;
}

/** Item ids the Agent Presets menu renders as navigation options instead of
 * informational rows. */
export const AGENT_MENU_OPTION_IDS: readonly string[] = [
	"agents.profiles",
	"agents.presets",
	"agents.classifier",
	"agents.orchestrator",
];

/** The informational rows the Agent Presets menu shows: every inventoried item
 * except the navigation options. Read-only rows are included, so an inventoried
 * setting — a file-only bound, the effective scope, routing defaults — is
 * never silently unshown. */
export function agentMenuInformationalItems(
	items: readonly SettingsItem[],
): SettingsItem[] {
	return items.filter((item) => !AGENT_MENU_OPTION_IDS.includes(item.id));
}

export interface AgentStatus {
	scope: SettingsScope;
	/** Configured application/library id when the page is project-scoped. */
	projectIdent?: string;
	repository?: string;
	/** Effective source and the files it was resolved from. */
	source?: string;
	files: readonly string[];
	conflicts: string[];
	error?: string;
	profiles: Array<{ name: string; value: string }>;
	presets: Array<{ name: string; value: string }>;
	routing: AgentRoutingEntry[];
	/** The Orchestrator session's configured model, thinking level and workflow
	 * monitor mode. */
	orchestrator?: { model?: string; thinking?: string; monitor?: string };
	/** The durable compaction policy the Compaction section renders. Absent
	 * until the read resolves; the section then says so. */
	compaction?: CompactionSettingsSnapshot;
}

/** Structural shape of the server's compaction read. Declared here rather than
 * imported so the settings surface keeps no runtime dependency on the server
 * module that owns the write path; the server's read is structurally
 * compatible. */
export interface CompactionSettingsSnapshot {
	readonly configured: Record<string, unknown>;
	readonly configuredIsDefault: boolean;
	readonly effective: {
		readonly enabled: boolean;
		readonly reserveTokens: number;
		readonly backgroundTokens: number;
		readonly keepRecentTokens: number;
	};
	readonly source: "agentHost" | "agents" | "default";
	readonly validation: readonly CompactionFieldError[];
	readonly defaults?: {
		readonly enabled: boolean;
		readonly reserveTokens: number;
		readonly backgroundTokens: number;
		readonly keepRecentTokens: number;
	};
	/** The resolved cost ceiling: the absolute line above which a long-lived
	 * session compacts at its next safe point, and why it is inactive when it is.
	 * Absent until a read carries it (an older server, or a hand-built snapshot). */
	readonly ceiling?: CompactionCeiling;
	/** The window a percentage resolved against, when the read knows one. The
	 * host resolves the real one per run from its own models. */
	readonly referenceWindow?: number;
}

export interface ProviderSnapshot {
	state: "loading" | "ready" | "error";
	providers: Array<{
		name: string;
		type: string;
		username: string;
		hasToken: boolean;
		invalid: boolean;
		problem?: string;
	}>;
	error?: string;
}

export interface ProjectSnapshot {
	state: "loading" | "ready" | "error";
	revision?: string;
	projects: Array<{
		ident: string;
		displayName: string;
		kind: string;
		available: boolean;
		repository?: string;
	}>;
	error?: string;
}

export interface SettingsContext {
	themes: string[];
	activeTheme: string;
	/** `$AGENTIC_CODING_CONFIG_DIR/tui.json`, the client-local preference file. */
	clientSettingsPath: string;
	/** The Settings page this snapshot is rendered for. */
	section: SettingsSection;
	agents: AgentStatus;
	providers: ProviderSnapshot;
	/** Classifier provider selection and local-model status. Absent until the
	 * first server read resolves; the item then states the built-in default. */
	classifier?: ClassifierStatusResponse;
	/** Browser install state and effective bounds. Absent until the first server
	 * read resolves. */
	browser?: BrowserStatusResponse;
	/** Stage catalog, credential status and diagnostics. Absent until the first
	 * server read resolves. */
	stages?: StagesStatusResponse;
	/** The live stage identity cache: `(stage, role, captured, expires)` only.
	 * Absent until the first server read resolves, and empty when nothing is
	 * cached — which is not the same fact. */
	stageIdentities?: StageIdentitiesResponse;
	/** Why the identity read failed, when the catalog itself succeeded. Passed in
	 * with the snapshot so the rows stay a pure function of the context. */
	stageIdentityError?: string;
	/** The scope a wide forget is armed on: the row says so, because an arm
	 * nothing renders is an arm nobody can see they took (USAB-302). */
	stageIdentityArmed?: { readonly stage?: string; readonly role?: string };
}

/** Where the Settings cursor goes after a forget removed the row it was on.
 *
 * The row that still names the scope wins (a stage-wide forget that left other
 * entries of that stage). Failing that, the same scope's *disarmed* row — a
 * stage's bounds row, which takes a second press again — and failing that the
 * nearest row above that a single Enter cannot turn into a forget: a sibling
 * `(stage, role)` entry row would make the next Enter forget a sign-in nobody
 * chose (USAB-201/USAB-301). */
export function identityForgetAnchor(
	rows: readonly SettingsItem[],
	target: { readonly stage?: string; readonly role?: string },
	from: number,
): number {
	const survives = rows.findIndex(
		(row) =>
			row.action.kind === "stage-identity-forget" &&
			row.action.stage === target.stage &&
			row.action.role === target.role,
	);
	if (survives >= 0) return survives;
	const parent = rows.findIndex(
		(row) =>
			row.action.kind === "stage-identity-forget" &&
			row.action.stage === target.stage &&
			row.action.role === undefined,
	);
	if (parent >= 0) return parent;
	for (let index = Math.min(from, rows.length - 1); index >= 0; index -= 1) {
		const row = rows[index];
		if (row === undefined) continue;
		const onePress =
			row.action.kind === "stage-identity-forget" &&
			row.action.role !== undefined;
		if (!onePress) return index;
	}
	return 0;
}

/** True when `scope` is the armed one: same stage, same role, both possibly
 * absent (a whole-cache arm names neither). */
function identityForgetArmed(
	context: SettingsContext,
	scope: { readonly stage?: string; readonly role?: string },
): boolean {
	const armed = context.stageIdentityArmed;
	return (
		armed !== undefined &&
		armed.stage === scope.stage &&
		armed.role === scope.role
	);
}

/** The structural shape of `[agents] file_judgment` this layer renders. Declared
 * here rather than imported so the settings surface keeps no runtime dependency
 * on the workflow layer; the parsed agents config is structurally compatible. */
export interface FileJudgmentSummary {
	enabled?: boolean;
	threshold?: number;
	unsure?: number;
	concurrency?: number;
}

/** The read-only label for the per-file judgment sweep. Only the bounds the
 * configuration actually sets are named: an unset bound is reported as the
 * default instead of a number this layer would have to duplicate from the
 * classifier protocol and could then drift from. */
export function fileJudgmentSummaryLabel(
	config: FileJudgmentSummary | undefined,
): string {
	if (config?.enabled !== true) return "disabled (default)";
	const bounds: string[] = [
		config.threshold !== undefined
			? `flag > ${config.threshold}`
			: "default flag threshold",
		config.unsure !== undefined
			? `unsure >= ${config.unsure}`
			: "default unsure floor",
	];
	if (config.concurrency !== undefined)
		bounds.push(`concurrency ${config.concurrency}`);
	return `enabled · ${bounds.join(" · ")}`;
}

function detailFor(
	scope: SettingsScope,
	storage: string,
	effect: SettingsEffect,
): string {
	return `${scopeLabel(scope)} · ${storage} · ${effectLabel(effect)}`;
}

/** The inventory detail line of one item id, so it is never hand-written. */
function inventoryDetail(id: string): string {
	const entry = inventoryEntry(id);
	return entry
		? detailFor(entry.scope, entry.storage, entry.effect)
		: "source unavailable";
}

function appearanceItems(context: SettingsContext): SettingsItem[] {
	return [
		{
			id: "appearance.theme",
			label: "Theme",
			value: context.activeTheme,
			detail: "Changes the colorscheme of the application",
			editable: true,
			action: { kind: "theme-picker" },
		},
	];
}

function agentItems(context: SettingsContext): SettingsItem[] {
	const agents = context.agents;
	const items: SettingsItem[] = [];
	const source = agents.source ?? "unavailable";
	const files = agents.files.length ? ` (${agents.files.join(", ")})` : "";
	items.push({
		id: "agents.scope",
		label: "Scope",
		value:
			agents.scope === "project"
				? `project ${agents.projectIdent ?? ""}`.trim()
				: "user configuration",
		detail: `${detailFor(agents.scope, `${source}${files}`, "next-start")}`,
		editable: false,
		action: { kind: "none" },
	});
	if (agents.repository) {
		items.push({
			id: "agents.repository",
			label: "Project checkout",
			value: agents.repository,
			detail: "where the project-scoped configuration is resolved from",
			editable: false,
			action: { kind: "none" },
		});
		items.push({
			id: "agents.reset-scope",
			label: "Reset to user scope",
			value: "",
			detail: `${detailFor("user", source, "next-start")} · leaves the project configuration untouched`,
			editable: true,
			action: { kind: "navigate", route: settingsRoute("agents") },
		});
	}

	if (agents.error) {
		items.push({
			id: "agents.error",
			label: "Configuration could not be read",
			value: agents.error,
			detail: "the last valid configuration is unchanged",
			editable: false,
			action: { kind: "none" },
		});
	}
	for (const conflict of agents.conflicts) {
		items.push({
			id: `agents.conflict.${conflict}`,
			label: "Conflicting [agents] definition",
			value: conflict,
			detail: "remove [agents] there before saving so edits are not shadowed",
			editable: false,
			action: { kind: "none" },
		});
	}
	// The section renders the two menu options as its first selectable rows; the
	// items stay declared here so the inventory reachability check can name them.
	items.push({
		id: "agents.profiles",
		label: "Agent profiles",
		value: `${agents.profiles.length} configured`,
		detail: `${detailFor(agents.scope, source, "next-start")} · edit a profile or add one`,
		editable: true,
		action: { kind: "none" },
	});
	items.push({
		id: "agents.presets",
		label: "Agent presets",
		value: `${agents.presets.length} configured`,
		detail: `${detailFor(agents.scope, source, "next-start")} · edit a preset or add one`,
		editable: true,
		action: { kind: "none" },
	});
	// The classifier provider is edited in the same Agent Presets surface, so the
	// item routes there rather than opening a second editor.
	items.push({
		id: "agents.classifier",
		label: "Classifier provider",
		value: classifierSelectionLabel(context.classifier),
		detail: `${detailFor("user", "[agents.classifier]", "next-start")} · edit in Agent Presets`,
		editable: true,
		action: { kind: "none" },
	});
	items.push({
		id: "agents.orchestrator",
		label: "Orchestrator session",
		value: orchestratorLabel(agents.orchestrator),
		detail: `${detailFor("user", "[agents.orchestrator]", "next-session")} · edit in Agent Presets`,
		editable: true,
		action: { kind: "none" },
	});
	for (const entry of agents.routing)
		items.push({
			id: `agents.routing.${entry.label}`,
			label: entry.label,
			value: entry.value,
			detail: `${detailFor("user", source, "next-start")} · read-only: edit the config file`,
			editable: false,
			action: { kind: "none" },
		});
	return items;
}

/** The one-line orchestrator session setting: `model · thinking · monitor`,
 * host defaults and the default `wake` mode named. */
export function orchestratorLabel(
	orchestrator:
		| { model?: string; thinking?: string; monitor?: string }
		| undefined,
): string {
	return `${orchestrator?.model ?? "host default model"} · ${orchestrator?.thinking ?? "default thinking"} · monitor ${orchestrator?.monitor ?? DEFAULT_ORCHESTRATOR_MONITOR}`;
}

/** The one-line classifier selection: the label of the selected provider, or
 * the built-in hosted default before the first status read. */
function classifierSelectionLabel(
	classifier: ClassifierStatusResponse | undefined,
): string {
	if (!classifier) return "Hosted (usage-based)";
	return (
		classifier.providers.find((option) => option.id === classifier.provider)
			?.label ?? classifier.provider
	);
}

/** Where the effective compaction values came from. */
export function compactionSourceLabel(
	source: CompactionSettingsSnapshot["source"],
): string {
	switch (source) {
		case "agentHost":
			return "from the agentHost.compaction override (wins over [agents.compaction])";
		case "agents":
			return "from [agents.compaction] (user configuration)";
		case "default":
			return "documented defaults (nothing configured)";
	}
}

/** One token field's row value: the configured form, the effective value the
 * host uses when it knows no window, and whether a default applied. */
export function compactionTokenValueLabel(
	configured: CompactionTokenValue | undefined,
	effective: number,
): string {
	if (configured === undefined) return `${effective} tokens (default)`;
	const percent =
		typeof configured === "string"
			? parseCompactionPercent(configured)
			: undefined;
	return percent !== undefined
		? `${configured} → ${effective} tokens without a known window`
		: `${effective} tokens`;
}

/** The effective value a token row shows. The cost ceiling is not part of the
 * policy pi-durable receives, so it comes from the resolved ceiling instead. */
export function compactionEffectiveValue(
	snapshot: CompactionSettingsSnapshot,
	field: CompactionTokenField,
): number {
	return field === "ceilingTokens"
		? (snapshot.ceiling?.ceilingTokens ?? COMPACTION_CEILING_DEFAULT)
		: snapshot.effective[field];
}

/** One line stating what the cost ceiling does, and — when it is resolved
 * inactive — which condition holds. */
export function compactionCeilingLabel(
	ceiling: CompactionCeiling | undefined,
): string {
	if (!ceiling) return `${COMPACTION_CEILING_DEFAULT} tokens (default)`;
	if (ceiling.inactive === "off") return "0 tokens (off)";
	if (ceiling.inactive === "disabled")
		return `${ceiling.ceilingTokens} tokens (off while automatic compaction is off)`;
	if (ceiling.inactive === "above-overflow")
		return `${ceiling.ceilingTokens} tokens (ignored: the overflow threshold is lower)${ceiling.overflowTokens !== undefined ? `, ${ceiling.overflowTokens}` : ""}`;
	return `${ceiling.ceilingTokens} tokens`;
}

/** The Compaction section (`add-agent-compaction`): the four values the durable
 * host resolves, the effective value of each, where it came from, and the
 * documented defaults. The reference window a percentage resolves against is
 * per run — the host owns it — so the section states the rule instead of
 * inventing a window this process cannot see. */
function compactionItems(context: SettingsContext): SettingsItem[] {
	const snapshot = context.agents.compaction;
	if (!snapshot) {
		// Before the first read resolves the row is loading, not unavailable, and a
		// read that failed states its own error instead of the generic sentence.
		// Either way Enter retries the read.
		const error = context.agents.error;
		return [
			{
				id: "compaction.unavailable",
				label: "Compaction",
				value: error ?? "loading…",
				detail: error
					? "the agents configuration could not be read; durable runs keep the defaults of the last valid configuration"
					: "reading the agents configuration; durable runs keep the defaults of the last valid configuration",
				editable: true,
				action: { kind: "retry" },
			},
		];
	}
	const source = compactionSourceLabel(snapshot.source);
	const items: SettingsItem[] = [];
	for (const error of snapshot.validation)
		items.push({
			id: `compaction.error.${error.field}`,
			label: `${error.field} is not usable`,
			value: error.message,
			detail:
				"the durable host falls back to the documented default for this field until it is fixed",
			editable: false,
			action: { kind: "none" },
		});
	items.push({
		id: "compaction.enabled",
		label: "Automatic compaction",
		value: snapshot.effective.enabled ? "on" : "off",
		detail: `${inventoryDetail("agents.compaction")} · ${source} · ${snapshot.effective.enabled ? "Enter turns it off" : "Enter turns it on"}; /compact in a session works either way`,
		editable: true,
		action: { kind: "compaction-toggle" },
	});
	const tokenRows: Array<{
		field: CompactionTokenField;
		label: string;
		why: string;
	}> = [
		{
			field: "reserveTokens",
			label: "Reserve tokens",
			why: `room kept free for the answer: a request above window − reserve waits for a summary (default ${compactionFieldDefaultForm("reserveTokens")}, so automatic compaction starts at ${COMPACTION_DEFAULT_TRIGGER_PERCENT}% of the run's own window); the summarizer's own output budget is 0.8 × reserve`,
		},
		{
			field: "backgroundTokens",
			label: "Background starts",
			why: `how far below the blocking threshold a summary starts in the background (default ${compactionFieldDefaultForm("backgroundTokens")}); 0 disables the background path`,
		},
		{
			field: "keepRecentTokens",
			label: "Kept verbatim",
			why: `recent context a summary keeps word for word (default ${compactionFieldDefaultForm("keepRecentTokens")}); a percentage like "15%" scales with each run's own model window, and the resolved tail is capped at half an active cost ceiling so the summary plus the tail stay under it`,
		},
		{
			field: "ceilingTokens",
			label: "Cost ceiling",
			why: `absolute context a long-lived session may carry before it compacts at the next safe point (default ${compactionFieldDefaultForm("ceilingTokens")}); it is a cost control, not an overflow guard, so it applies only when it sits below the window's overflow threshold — otherwise it is ignored with a warning event. 0 turns it off; automatic compaction off turns it off too`,
		},
	];
	const configured = snapshot.configured as Record<string, unknown>;
	for (const row of tokenRows) {
		const raw = configured[row.field];
		const configuredValue =
			typeof raw === "number" || typeof raw === "string" ? raw : undefined;
		const percent =
			typeof configuredValue === "string"
				? parseCompactionPercent(configuredValue)
				: undefined;
		items.push({
			id: `compaction.${row.field}`,
			label: row.label,
			value:
				row.field === "ceilingTokens" &&
				configuredValue === undefined &&
				snapshot.ceiling !== undefined &&
				!snapshot.ceiling.active
					? compactionCeilingLabel(snapshot.ceiling)
					: compactionTokenValueLabel(
							configuredValue,
							compactionEffectiveValue(snapshot, row.field),
						),
			detail: [
				source,
				row.why,
				percent !== undefined
					? "the host resolves the percentage against the smallest context window its runs use"
					: "",
				row.field === "ceilingTokens"
					? `Enter edits (whole tokens, 0 to turn it off, or ${COMPACTION_CEILING_MINIMUM}–${COMPACTION_TOKEN_CEILING})`
					: `Enter edits (whole tokens, ${compactionFieldMinimum(row.field)}–${COMPACTION_TOKEN_CEILING}, or ${COMPACTION_PERCENT_MIN}%–${COMPACTION_PERCENT_MAX}%)`,
			]
				.filter(Boolean)
				.join(" · "),
			editable: true,
			action: { kind: "numeric-edit", field: row.field },
		});
	}
	items.push({
		id: "compaction.reference-window",
		label: "Reference window",
		value:
			snapshot.referenceWindow !== undefined
				? `${snapshot.referenceWindow} tokens`
				: "per run: the smallest model window its host tracks",
		detail:
			"a percentage resolves against it; with no known window the field's documented default applies · absolute values are used as written",
		editable: false,
		action: { kind: "none" },
	});
	items.push({
		id: "compaction.applies",
		label: "Applies to",
		value: "every durable run, running ones included",
		detail: `${inventoryDetail("agents.compaction")} · the host re-reads the policy at every generation, so a save reaches a run already in flight`,
		editable: false,
		action: { kind: "none" },
	});
	return items;
}

function providerItems(context: SettingsContext): SettingsItem[] {
	const providers = context.providers;
	if (providers.state === "loading")
		return [
			{
				id: "providers.loading",
				label: "Providers",
				value: "loading…",
				detail: "reading provider status from the connected server",
				editable: false,
				action: { kind: "none" },
			},
		];
	if (providers.state === "error")
		return [
			{
				id: "providers.error",
				label: "Providers unavailable",
				value: providers.error ?? "unavailable",
				detail:
					"the connected server could not be read; no local configuration was written",
				editable: false,
				action: { kind: "none" },
			},
			{
				id: "providers.retry",
				label: "Retry",
				value: "",
				detail: "read the connected server again",
				editable: true,
				action: { kind: "retry" },
			},
		];
	const items: SettingsItem[] = providers.providers.map((provider) => ({
		id: `providers.${provider.name}`,
		label: provider.name,
		value: [provider.type, provider.username].filter(Boolean).join(" · "),
		detail: [
			provider.hasToken
				? "credential stored on the server (masked)"
				: "no credential stored",
			provider.invalid
				? `needs attention: ${provider.problem ?? "invalid"}`
				: "",
			"edit in Environments",
		]
			.filter(Boolean)
			.join(" · "),
		editable: true,
		action: {
			kind: "navigate",
			route: { page: "environments.applications" },
		},
	}));
	items.push({
		id: "providers.credentials",
		label: "Provider credentials",
		value: `${providers.providers.filter((provider) => provider.hasToken).length} stored`,
		detail: `${inventoryDetail("providers.credentials")} · values are never shown here`,
		editable: false,
		action: { kind: "none" },
	});
	return items;
}

/** Items of one Settings section for the resolved snapshot. */
export function settingsItems(context: SettingsContext): SettingsItem[] {
	switch (context.section) {
		case "appearance":
			return appearanceItems(context);
		case "agents":
			return agentItems(context);
		case "browser":
			return browserItems(context);
		case "compaction":
			return compactionItems(context);
		case "providers":
			return providerItems(context);
		case "stages":
			return stageItems(context);
	}
}

/**
 * The Stages section (`add-stage-testing-foundation`, task 5.1). Read-only
 * structure: which hosted stages this configuration allows, what each one
 * contains and why a file was refused. The one write is a credential, and it
 * goes through the protected `.env` flow — a row offers it only for a variable
 * the catalog actually references, and the value never comes back.
 */
function stageItems(context: SettingsContext): SettingsItem[] {
	const stages = context.stages;
	if (!stages) return stageUnavailableItems(lastStageError());
	const items: SettingsItem[] = [];
	items.push({
		id: "stages.root",
		label: "Stage definitions",
		value: `${stages.stages.length} allowed · ${stages.excluded.length} refused`,
		detail: `${inventoryDetail("stages.catalog")} · ${stages.configDir}`,
		editable: false,
		action: { kind: "none" },
	});
	for (const stage of stages.stages) {
		const where = `${stage.environment}/${stage.system}`;
		items.push({
			id: `stages.stage.${stage.ident}`,
			label: stage.displayName,
			value: `${stage.access} · ${where} · ${stage.apps.length} app${stage.apps.length === 1 ? "" : "s"}`,
			detail: [
				`plan approval ${stage.planApproval}${stage.exclusive ? " · exclusive" : ""}`,
				stage.origins.length
					? `navigations stay on ${stage.origins.join(", ")}`
					: "no origin declared: the guard would refuse every navigation",
				stage.readOnlyExceptions.length
					? `${stage.readOnlyExceptions.length} read-only exception${stage.readOnlyExceptions.length === 1 ? "" : "s"}`
					: "",
			]
				.filter(Boolean)
				.join(" · "),
			editable: false,
			action: { kind: "none" },
		});
		// The identity cache of this stage (`add-stage-identity-cache`): its bounds
		// first — which are also this stage's "forget every cached sign-in" action —
		// then one row per cached `(stage, role)`. A row carries the key and two
		// instants: the section never sees a cookie, a storage key or a value, because
		// the server's listing cannot express one.
		// The listing's absence is not "nothing is cached": a failed identity read
		// leaves the catalog usable, so the row has to say that it does not know
		// rather than describe an empty cache it never saw.
		const known = context.stageIdentities !== undefined;
		const cached = cachedIdentitiesFor(context.stageIdentities, stage.ident);
		const stageArmed = identityForgetArmed(context, { stage: stage.ident });
		items.push({
			id: `stages.identity.${stage.ident}`,
			label: "Identity cache",
			value: `${identityCacheValue(
				stage.identityCache,
				known ? cached.length : undefined,
			)}${stageArmed ? " · armed: press Enter again" : ""}`,
			detail: [
				...(stageArmed
					? [
							"armed: the first Enter asked for confirmation, and this one forgets them",
						]
					: []),
				inventoryDetail("stages.identity"),
				"a cached sign-in lives only in this server's memory: it is never written to disk, never returned by a tool and never shown here, and a restart starts empty",
				known
					? cached.length > 0
						? `Enter forgets all ${cached.length} of them: the next session of each role logs in the normal way`
						: "nothing is cached for this stage yet"
					: "what this stage holds is unknown: the listing of cached sign-ins could not be read, and Enter does nothing until it can",
			].join(" · "),
			editable: cached.length > 0,
			action:
				cached.length > 0
					? {
							kind: "stage-identity-forget",
							stage: stage.ident,
							label:
								cached.length === 1
									? `the cached sign-in of ${stage.displayName}`
									: `all ${cached.length} cached sign-ins of ${stage.displayName}`,
						}
					: { kind: "none" },
		});
		for (const entry of cached)
			items.push(identityEntryItem(stage.ident, stage.displayName, entry));
		for (const app of stage.apps) {
			items.push({
				id: `stages.app.${stage.ident}.${app.key}`,
				label: `${app.label} (${app.kind})`,
				value: app.url,
				detail: [
					app.app ? `app ${app.app}` : "no configured app linked",
					app.version
						? `version ${app.version.path} → ${app.version.status === "ok" ? (app.version.value ?? "ok") : "not discoverable"}`
						: "no version probe",
					app.roles.length
						? `roles: ${app.roles.map((role) => role.role).join(", ")}`
						: "no roles: stage_login answers login-not-required",
				].join(" · "),
				editable: false,
				action: { kind: "none" },
			});
			for (const role of app.roles) {
				// What a run can expect of this role's login: the credential status
				// decides whether it can be automated at all, and the login mode says
				// whether this server would perform it or hand it to the developer.
				items.push({
					id: `stages.login.${stage.ident}.${app.key}.${role.role}`,
					label: `${role.role} · login`,
					value: `${role.loginMode}${role.credentials.length === 0 ? "" : ` · credentials ${role.credentialStatus}`}`,
					detail: [
						`${inventoryDetail("stages.credentials")} · ${app.label} · recipe ${role.login ?? "none"}${role.loginKind ? ` (${role.loginKind})` : ""}`,
						role.loginMode === "handoff"
							? "the server cannot perform this login: stage_login hands it to you in a headed window, and stage_login_wait blocks until it ends"
							: role.loginMode === "unavailable"
								? 'this login needs you and this configuration forbids the headed window (stages/policy.json "interactiveLogin"): stage_login answers login-user-unavailable'
								: "the server performs this login from the configured credentials",
					].join(" · "),
					editable: false,
					action: { kind: "none" },
				});
			}
			for (const role of app.roles)
				for (const credential of role.credentials) {
					// The variable is named with *both* statuses: a value that is already set
					// can still be replaced, so the row that would replace it has to say which
					// key it writes. A row is therefore always the credential editor.
					const variable = credential.variable;
					const set = credential.status === "set";
					items.push({
						id: `stages.credentials.${stage.ident}.${app.key}.${role.role}.${credential.field}`,
						label: `${role.role} · ${credential.field}`,
						value: set ? `set ${variable} (masked)` : `missing ${variable}`,
						detail: [
							`${inventoryDetail("stages.credentials")} · ${app.label} · login ${role.login ?? "none"}${role.loginKind ? ` (${role.loginKind})` : ""}`,
							set
								? `the value stays in the configuration \`.env\` and is never shown here · Enter replaces ${variable}`
								: `Enter sets ${variable} in the configuration \`.env\``,
						].join(" · "),
						editable: true,
						action: {
							kind: "stage-credential",
							variable,
							// Field first: the dialog puts the variable in front of this, and a
							// narrow terminal clips the tail. The variable already names the field
							// (`…_PASSWORD`), so what has to survive after it is the role and the
							// application the credential belongs to.
							label: `${credential.field} · ${role.role} · ${app.label} · ${stage.displayName}`,
						},
					});
				}
		}
		for (const diagnostic of stage.diagnostics)
			items.push({
				id: `stages.diagnostic.${stage.ident}.${diagnostic}`,
				label: "Diagnostic",
				value: diagnostic,
				detail:
					"the stage is allowed with this warning; every durable run reads the same diagnostics through stage_info",
				editable: false,
				action: { kind: "none" },
			});
	}
	for (const excluded of stages.excluded)
		items.push({
			id: `stages.excluded.${excluded.file}`,
			label: excluded.ident
				? `${excluded.ident} (refused)`
				: `${excluded.file} (refused)`,
			value: excluded.diagnostics.join(" · "),
			detail:
				"a refused stage is never configured as one: fix the file and the next read allows it",
			editable: false,
			action: { kind: "none" },
		});
	if (stages.stages.length === 0 && stages.excluded.length === 0)
		items.push({
			id: "stages.empty",
			label: "No stage definitions",
			value: `${stages.configDir}/stages/definitions`,
			detail:
				"add a stage definition there (and optionally stages/policy.json) so agent runs may drive a hosted stage",
			editable: false,
			action: { kind: "none" },
		});
	// A cached sign-in whose stage this configuration no longer allows is still in
	// the server's memory (up to its TTL), so it has to stay reachable: rendered
	// from the listing rather than from the catalog, with its key and its forget
	// action and no bounds to show.
	const allowed = new Set(stages.stages.map((entry) => entry.ident));
	for (const [ident, entries] of cachedIdentitiesByStage(
		context.stageIdentities,
	))
		if (!allowed.has(ident)) {
			const orphanArmed = identityForgetArmed(context, { stage: ident });
			items.push({
				id: `stages.identity.orphan.${ident}`,
				label: "Identity cache",
				value: `${entries.length} cached sign-in${entries.length === 1 ? "" : "s"} for a stage this configuration no longer allows${orphanArmed ? " · armed: press Enter again" : ""}`,
				detail: [
					inventoryDetail("stages.identity"),
					`stage ${ident} is not in the allow-list: its file was removed, renamed or refused`,
					"Enter forgets them: an entry would otherwise live until its TTL ends",
				].join(" · "),
				editable: true,
				action: {
					kind: "stage-identity-forget",
					stage: ident,
					label: `the cached sign-ins of the stage ${ident}`,
				},
			});
			for (const entry of entries)
				items.push(identityEntryItem(ident, ident, entry));
		}
	// The whole cache comes last: the widest scope belongs at the end of the
	// section it clears, and it is one activation instead of one per stage.
	const all = context.stageIdentities?.entries ?? [];
	if (all.length > 0) {
		const allArmed = identityForgetArmed(context, {});
		items.push({
			id: "stages.identity.all",
			label: "Forget every cached sign-in",
			value: `${all.length} cached · server-wide${allArmed ? " · armed: press Enter again" : ""}`,
			detail: [
				...(allArmed
					? [
							"armed: the first Enter asked for confirmation, and this one forgets every cached sign-in",
						]
					: []),
				inventoryDetail("stages.identity"),
				"Enter forgets every cached identity in this server's memory, of every stage and role",
				"the browser sessions that live right now keep their own state",
			].join(" · "),
			editable: true,
			action: {
				kind: "stage-identity-forget",
				label: `all ${all.length} cached sign-ins`,
			},
		});
	}
	// A failed identity read is reported where the identity rows would be, and
	// never as a failure of the catalog above it: the credential rows still work.
	const identityError = context.stageIdentityError;
	if (identityError !== undefined)
		items.push({
			id: "stages.identity.unreadable",
			label: "Cached sign-ins",
			value: "unreadable",
			detail: `the cached sign-ins could not be read: ${identityError} · the stage catalog above was read`,
			editable: false,
			action: { kind: "none" },
		});
	return items;
}

/** The identity cache's effective bounds of one stage, as one line. `maxEntries`
 * is the *process* cap rather than a per-stage capacity, and it is named as one:
 * every stage row would otherwise read "max 8" as its own budget. */
function identityCacheValue(
	bounds: {
		readonly enabled: boolean;
		readonly ttlMinutes: number;
		readonly maxEntries: number;
		readonly refreshSeconds: number;
	},
	/** How many entries this stage holds, or `undefined` when the listing could not
	 * be read — which is not the same as zero. */
	cached: number | undefined,
): string {
	if (!bounds.enabled) return "off (identityCache: false)";
	return [
		"enabled",
		`ttl ${bounds.ttlMinutes} min`,
		`re-captured on the first call after ${bounds.refreshSeconds}s`,
		`server-wide cap ${bounds.maxEntries} entries`,
		cached === undefined ? "contents unknown" : `${cached} cached`,
	].join(" · ");
}

/** One cached `(stage, role)` row: the key, two instants and the forget action. */
function identityEntryItem(
	stage: string,
	stageLabel: string,
	entry: StageIdentityStatus,
): SettingsItem {
	return {
		id: `stages.identity.${stage}.${entry.role}`,
		label: `${entry.role} · cached sign-in`,
		value: [
			`captured ${relativeInstant(entry.capturedAt)}`,
			`expires ${relativeInstant(entry.expiresAt)}`,
			// A count, never a value: a capture that hit the bounds says so, so an
			// operator debugging a login that needs a value the cache dropped can see
			// that it was cut short instead of blaming the application.
			...(entry.truncated > 0
				? [`${entry.truncated} values too short, long or many to keep`]
				: []),
		].join(" · "),
		detail: [
			inventoryDetail("stages.identity"),
			`key ${stage}/${entry.role}`,
			"Enter forgets it: the next session of this role logs in the normal way",
			"the browser sessions that live right now keep their own state",
		].join(" · "),
		editable: true,
		action: {
			kind: "stage-identity-forget",
			stage,
			role: entry.role,
			label: `${entry.role} · ${stageLabel}`,
		},
	};
}

/** Every cached identity, grouped by the stage it belongs to. */
function cachedIdentitiesByStage(
	identities: StageIdentitiesResponse | undefined,
): Map<string, StageIdentityStatus[]> {
	const byStage = new Map<string, StageIdentityStatus[]>();
	for (const entry of identities?.entries ?? []) {
		const list = byStage.get(entry.stage) ?? [];
		list.push(entry);
		byStage.set(entry.stage, list);
	}
	return byStage;
}

/** The cached identities of one stage, or none when the read has not landed. */
function cachedIdentitiesFor(
	snapshot: StageIdentitiesResponse | undefined,
	stage: string,
): readonly StageIdentityStatus[] {
	if (!snapshot) return [];
	return snapshot.entries.filter((entry) => entry.stage === stage);
}

/** "in 42 min" / "3 min ago": a bound the developer can compare with the TTL the
 * row above it reports, without a clock in the section. */
function relativeInstant(at: number): string {
	const delta = at - Date.now();
	const minutes = Math.round(Math.abs(delta) / 60_000);
	if (minutes < 1) return "just now";
	return delta < 0 ? `${minutes} min ago` : `in ${minutes} min`;
}

function stageUnavailableItems(error: string | undefined): SettingsItem[] {
	// "There is no snapshot yet" and "the read failed" are different facts, and
	// only one of them is worth retrying *because* something broke. Both get an
	// explicit, separately labelled retry row: a blank section with no way to ask
	// again is the state a developer cannot get out of.
	return [
		{
			id: "stages.unavailable",
			label: "Stages",
			value: error ? "unavailable" : "loading…",
			detail: error
				? `the connected server could not be read: ${error} · an unreachable server never falls back to a local configuration`
				: "the stage catalog is read from the connected server and has not answered yet",
			editable: false,
			action: { kind: "none" },
		},
		{
			id: "stages.retry",
			// Both branches read the row's state: "retry" over a section that is
			// merely *reading* (its own value is `reading…`) would be a lie, so the
			// label follows the branch where the value does.
			label: error ? "Retry the stage read" : "Read the stage catalog again",
			value: error ? "retry" : "reading…",
			detail:
				"read the connected server again and replace this section with what it answers",
			editable: true,
			action: { kind: "retry" },
		},
	];
}

/** One-line browser phase copy; the raw enum is never shown. */
function browserPhaseLabel(
	install: BrowserStatusResponse["install"] | undefined,
): string {
	switch (install?.phase) {
		case "downloading":
			return "installing…";
		case "ready":
			return "installed";
		case "failed":
			return install.detail ?? "install failed";
		case "cancelled":
			return "install cancelled";
		default:
			return "not installed";
	}
}

/**
 * The Browser section: which browser the server would launch, the opt-in
 * install (the only download path in the application) and the effective
 * `browser.*` bounds.
 */
function browserItems(context: SettingsContext): SettingsItem[] {
	const browser = context.browser;
	if (!browser)
		return [
			{
				id: "browser.unavailable",
				label: "Browser",
				value: "unavailable",
				detail:
					"the connected server could not be read; an unreachable server never falls back to a local configuration",
				editable: true,
				action: { kind: "retry" },
			},
		];
	const items: SettingsItem[] = [];
	const where =
		browser.source === "system-chrome"
			? `system Chrome · ${browser.systemChrome ?? browser.executablePath ?? "detected"}`
			: browser.source === "installed-chromium"
				? `installed Chromium · ${browser.executablePath ?? browser.browsersPath}`
				: "none installed";
	items.push({
		id: "browser.state",
		label: "Headless browser",
		value: where,
		detail: [
			`${inventoryDetail("browser.install")} · agent runs drive one shared process`,
			// A `stage_login` hand-off needs a browser that can show a window, which
			// a shell-only install cannot: the row says so before a hand-off is asked
			// for, instead of the login failing at the last moment.
			browser.headed
				? "a login hand-off can open a visible window"
				: "no login window: install Chromium here (or Google Chrome), and check the display on Linux",
		].join(" · "),
		editable: false,
		action: { kind: "none" },
	});
	const downloading = browser.install.phase === "downloading";
	// The install row keeps its position *and* its id while a download runs, and
	// becomes inert rather than turning into the cancel action: a held or repeated
	// Enter then repeats a no-op instead of cancelling the download it just started.
	items.push({
		id: "browser.install",
		label: "Install Chromium",
		value: browserPhaseLabel(browser.install),
		detail: downloading
			? `${inventoryDetail("browser.install")} · a download is already running; cancel it with the row below`
			: `${inventoryDetail("browser.install")} · downloads Chrome for Testing (~150 MB) into ${browser.browsersPath}; nothing is downloaded until you activate this row`,
		// Editable is the section's word for "not a config-file setting"; this row
		// is temporarily inert, not read-only, so it keeps that word and makes its
		// action a no-op instead of borrowing the read-only suffix.
		editable: true,
		action: downloading ? { kind: "none" } : { kind: "browser-install" },
	});
	if (downloading)
		items.push({
			id: "browser.cancel",
			label: "Cancel download",
			value: browser.install.detail ?? "downloading",
			detail: `${inventoryDetail("browser.install")} · the partial download is left for the next attempt`,
			editable: true,
			action: { kind: "browser-install-cancel" },
		});
	const settings = browser.settings;
	items.push({
		id: "browser.max-sessions",
		label: "Max sessions",
		value: String(settings.maxSessions),
		detail: `${inventoryDetail("browser.sessions")} · read-only: edit the config file`,
		editable: false,
		action: { kind: "none" },
	});
	items.push({
		id: "browser.idle-ttl",
		label: "Idle TTL",
		value: `${Math.round(settings.idleTtlMs / 60_000)} min`,
		detail: `${inventoryDetail("browser.sessions")} · read-only: edit the config file`,
		editable: false,
		action: { kind: "none" },
	});
	items.push({
		id: "browser.viewport",
		label: "Default viewport",
		value: `${settings.viewport.width}×${settings.viewport.height}`,
		detail: `${inventoryDetail("browser.sessions")} · screenshots returned to a model are at most 1280 px wide`,
		editable: false,
		action: { kind: "none" },
	});
	return items;
}
