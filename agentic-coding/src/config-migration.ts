// Explicit, recoverable configuration migration (unify-json-configuration-
// directory, tasks 4.1-4.3). It converts the pre-JSON workflow configuration to
// `config.json`, moves the legacy environment configuration root into the shared
// canonical root, and never touches runtime data (checkouts, databases, script
// logs, the knowledge wiki).
//
// Safety properties this module deliberately keeps:
//  - preview by default; nothing is written without `--apply`
//  - sources are fingerprinted and copied into a protected backup before any
//    published file changes
//  - conflicting target files, duplicate definition ids and differing `.env`
//    values are conflicts, never last-write-wins
//  - reports are value-free: file names, key names and counts only
//  - an interrupted publish leaves a journal that blocks configuration reads
//    until `--resume` or `--rollback` restores a consistent state
//
// ponytail: writer exclusion is the journal guard plus the documented "stop the
// server before --apply" precondition. There is no cross-process configuration
// lock to reuse, and inventing one is out of scope here; the journal makes an
// interrupted cutover fail loudly instead of silently mixing two states.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrationJournalPath, resolveConfigRoot } from "./config-root.ts";
import { envReferenceName, loadEnvFile, upsertEnvFile } from "./env-file.ts";
import { providerCredentialEnvKeys } from "./server/integrations/provider-store.ts";
import {
	DEFAULT_CONFIG,
	deepMergeConfig,
	LEGACY_WORKFLOW_CONFIG_FILE,
	parseConfigDocument,
	readConfigDocument,
	WORKFLOW_CONFIG_FILE,
} from "./workflow/effects.ts";

/** Configuration assets migrated from the legacy environment root. Anything not
 * listed here is reported rather than moved. */
const MIGRATED_ENV_ASSETS = [
	".env",
	"tui.json",
	"themes",
	"providers",
	"apps",
	"libraries",
	"infrastructure",
	"templates",
] as const;

/** Runtime/state entries that must never relocate. */
const RUNTIME_ENTRIES = ["logs"] as const;

const DEFINITION_DIRS = [
	path.join("apps", "definitions"),
	path.join("libraries", "definitions"),
	path.join("infrastructure", "definitions"),
] as const;

const BACKUP_DIR_NAME = ".config-backup";
const JOURNAL_VERSION = 1;

export interface MigrationConflict {
	readonly kind:
		| "existing-target"
		| "duplicate-ident"
		| "env-value"
		| "symlink"
		| "unsupported-value"
		| "suspicious-field"
		| "ambiguous-source";
	/** Files or variable/key names involved. Never a value. */
	readonly detail: string;
	readonly resolution: string;
}

export interface MigrationAction {
	/** `convert-workflow` rewrites TOML as JSON; `copy-asset` copies a new file;
	 * `merge-env` keeps the existing target and appends only missing keys;
	 * `extract-credentials` moves a literal provider credential into the
	 * protected `.env` and leaves a reference behind in the JSON;
	 * `strip-presets` deletes the stored agent presets during the pools hard
	 * break, keeping profiles and every non-preset agents field. */
	readonly kind:
		| "convert-workflow"
		| "copy-asset"
		| "merge-env"
		| "extract-credentials"
		| "strip-presets";
	readonly from: string;
	readonly to: string;
	/** Strip stored agent presets while publishing this action. */
	readonly stripPresets?: boolean;
	/** Credential pairs written into the protected `.env`. Names and values are
	 * only ever written there, never reported. */
	readonly envPairs?: ReadonlyMap<string, string>;
	/** Target `.env` receiving {@link envPairs}. */
	readonly envTarget?: string;
}

export interface MigrationSkip {
	readonly path: string;
	readonly reason: string;
}

export interface MigrationPlan {
	readonly sourceEnvRoot: string;
	readonly targetRoot: string;
	readonly actions: readonly MigrationAction[];
	readonly conflicts: readonly MigrationConflict[];
	readonly skipped: readonly MigrationSkip[];
	/** Secret-carrying variable names encountered, never their values. */
	readonly secretKeyNames: readonly string[];
	/** Stored agent presets the hard break will delete (profiles stay). */
	readonly presetsRemoved: number;
	readonly pendingJournal: boolean;
}

function sha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isSymlink(file: string): boolean {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Canonical JSON used for value equality and for the parity assertion. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Number of stored agent presets in a config document; the built-in
 * `use-default-model` is stored too and is stripped with the rest. */
function presetCount(document: unknown): number {
	if (!document || typeof document !== "object") return 0;
	const agents = (document as { agents?: unknown }).agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return 0;
	const presets = (agents as { presets?: unknown }).presets;
	if (!presets || typeof presets !== "object" || Array.isArray(presets))
		return 0;
	return Object.keys(presets as Record<string, unknown>).length;
}

/** Delete the stored preset table in place, keeping profiles, default profile,
 * routes, role routes, and definition defaults. */
function stripPresets(document: Record<string, unknown>): void {
	const agents = document.agents;
	if (agents && typeof agents === "object" && !Array.isArray(agents))
		delete (agents as Record<string, unknown>).presets;
}

function listFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// Finder metadata is not configuration; it is never migrated.
			if (entry.name === ".DS_Store" || entry.name === ".localized") continue;
			const full = path.join(dir, entry.name);
			if (isSymlink(full)) {
				found.push(full);
				continue;
			}
			if (entry.isDirectory()) walk(full);
			else found.push(full);
		}
	};
	walk(root);
	return found;
}

/** Values JSON cannot represent losslessly: non-finite numbers, and anything
 * whose prototype is not a plain object (Bun's TOML parser yields Temporal
 * values such as `Instant`/`PlainDate`, which JSON.stringify would flatten to a
 * string and silently change the type). */
function unsupportedValues(value: unknown, trail: string): string[] {
	if (typeof value === "number" && !Number.isFinite(value))
		return [`${trail} is a non-finite number`];
	if (Array.isArray(value))
		return value.flatMap((item, index) =>
			unsupportedValues(item, `${trail}[${index}]`),
		);
	if (value && typeof value === "object") {
		const proto = Object.getPrototypeOf(value) as object | null;
		if (proto !== Object.prototype && proto !== null) {
			const name =
				(value as { constructor?: { name?: string } }).constructor?.name ??
				"non-plain object";
			return [
				`${trail} is a ${name} value that JSON cannot represent losslessly`,
			];
		}
		return Object.entries(value as Record<string, unknown>).flatMap(
			([key, item]) => unsupportedValues(item, trail ? `${trail}.${key}` : key),
		);
	}
	return [];
}

/** A literal credential found in a provider file, with the reference form that
 * replaces it. `pairs` holds the values that move into `.env`. */
interface CredentialExtraction {
	readonly envPairs: Map<string, string>;
	readonly document: Record<string, unknown>;
}

const CREDENTIAL_FIELDS: readonly [string, 0 | 1][] = [
	["username", 0],
	["token", 1],
];

/** Field names that look like a credential but are not part of the provider
 * contract: they are reported for operator review, never guessed at. */
const SUSPICIOUS_FIELD =
	/^(password|passphrase|secret|api[_-]?key|apikey|bearer|credential|auth|private[_-]?key)$/i;

/**
 * Find the credentials a provider file stores in clear text and turn them into
 * a protected-`.env` write plus a reference (task 3.3). Only the fields the
 * provider store treats as reference-capable are moved; an unknown
 * credential-looking field is reported by name for review, because this code
 * cannot know whether it is a secret or a legitimate value.
 */
function extractionFor(file: string): {
	extraction?: CredentialExtraction;
	suspicious: string[];
} {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
		string,
		unknown
	>;
	const providerName =
		typeof parsed.name === "string" && parsed.name !== ""
			? parsed.name
			: path.basename(file, ".json");
	const keys = providerCredentialEnvKeys(providerName);
	const envPairs = new Map<string, string>();
	const document = { ...parsed };
	for (const [field, index] of CREDENTIAL_FIELDS) {
		const value = parsed[field];
		if (typeof value !== "string" || value === "") continue;
		// An existing reference is already the target shape.
		if (envReferenceName(value) !== undefined) continue;
		const envKey = keys[index];
		envPairs.set(envKey, value);
		document[field] = `\${${envKey}}`;
	}
	const suspicious = Object.keys(parsed).filter(
		(key) =>
			SUSPICIOUS_FIELD.test(key) &&
			typeof parsed[key] === "string" &&
			parsed[key] !== "",
	);
	if (envPairs.size === 0) return { suspicious };
	return { extraction: { envPairs, document }, suspicious };
}

/** Definition file hashes by declared `ident`, per root. */
function definitionIdents(root: string): Map<string, string> {
	const idents = new Map<string, string>();
	for (const relative of DEFINITION_DIRS) {
		const dir = path.join(root, relative);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const file = path.join(dir, entry.name);
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
					ident?: unknown;
				};
				if (typeof parsed.ident !== "string" || parsed.ident === "") continue;
				idents.set(
					parsed.ident,
					`${path.join(relative, entry.name)}:${sha256(file)}`,
				);
			} catch {}
		}
	}
	return idents;
}

export interface MigrationOptions {
	/** Legacy environment configuration root. Defaults to `DEVENV_CONFIG_DIR`
	 * or `~/.config/devenv`. */
	readonly source?: string;
	/** Canonical target root. Defaults to the shared resolver. */
	readonly target?: string;
	readonly home?: string;
}

export function legacyEnvRoot(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home = os.homedir(),
): string {
	const configured = env.DEVENV_CONFIG_DIR;
	if (configured !== undefined && configured !== "")
		return path.resolve(configured);
	return path.join(home, ".config", "devenv");
}

/**
 * Inventory both roots and the legacy workflow configuration. Pure observation:
 * it reads files to fingerprint and compare them but writes nothing.
 */
export function planMigration(options: MigrationOptions = {}): MigrationPlan {
	const home = options.home ?? os.homedir();
	const sourceEnvRoot = path.resolve(
		options.source ?? legacyEnvRoot(process.env, home),
	);
	const targetRoot = path.resolve(options.target ?? resolveConfigRoot());
	const actions: MigrationAction[] = [];
	const conflicts: MigrationConflict[] = [];
	const skipped: MigrationSkip[] = [];
	const secretKeyNames = new Set<string>();
	let presetsRemoved = 0;

	if (sourceEnvRoot === targetRoot)
		conflicts.push({
			kind: "ambiguous-source",
			detail: `source and target are the same directory (${targetRoot})`,
			resolution: "pass a distinct --source for the legacy root",
		});

	// 1. Workflow configuration: legacy TOML -> JSON under the target root.
	const legacyWorkflow = [
		path.join(targetRoot, LEGACY_WORKFLOW_CONFIG_FILE),
		path.join(home, ".pi", "agent", "herdr-workflow.toml"),
	].find((candidate) => fs.existsSync(candidate));
	const targetWorkflow = path.join(targetRoot, WORKFLOW_CONFIG_FILE);
	if (legacyWorkflow !== undefined) {
		if (isSymlink(legacyWorkflow))
			conflicts.push({
				kind: "symlink",
				detail: `${legacyWorkflow} is a symlink`,
				resolution:
					"materialize the link as a regular file (keeping its content) before migrating",
			});
		else if (fs.existsSync(targetWorkflow))
			skipped.push({
				path: legacyWorkflow,
				reason: `${WORKFLOW_CONFIG_FILE} already exists and wins; the legacy file stays inactive`,
			});
		else {
			const parsed = readConfigDocument(legacyWorkflow);
			const unsupported = unsupportedValues(parsed, "");
			if (unsupported.length)
				for (const detail of unsupported)
					conflicts.push({
						kind: "unsupported-value",
						detail: `${legacyWorkflow}: ${detail}`,
						resolution:
							"remove or convert the unsupported value by hand; it cannot be represented in JSON",
					});
			else
				actions.push({
					kind: "convert-workflow",
					from: legacyWorkflow,
					to: targetWorkflow,
				});
		}
	}

	// 1b. Hard config break (classifier-driven-model-pools): the stored preset
	// table is superseded by per-step model pools. Detect it in the effective
	// canonical config, or in a legacy TOML whose conversion is still pending,
	// and plan to delete it while keeping profiles and the other agents fields.
	const conversionIndex = actions.findIndex(
		(action) =>
			action.kind === "convert-workflow" && action.to === targetWorkflow,
	);
	if (conversionIndex >= 0 && legacyWorkflow !== undefined) {
		try {
			const count = presetCount(readConfigDocument(legacyWorkflow));
			if (count > 0) {
				actions[conversionIndex] = {
					...actions[conversionIndex],
					stripPresets: true,
				};
				presetsRemoved += count;
			}
		} catch {}
	} else if (fs.existsSync(targetWorkflow) && isSymlink(targetWorkflow)) {
		// A symlinked canonical config would be silently skipped by the strip
		// path; surface it as a conflict like the legacy-TOML symlink branch.
		try {
			const count = presetCount(
				JSON.parse(fs.readFileSync(targetWorkflow, "utf8")),
			);
			if (count > 0)
				conflicts.push({
					kind: "symlink",
					detail: `${targetWorkflow} is a symlink carrying stored presets`,
					resolution:
						"materialize the link as a regular file (keeping its content) before migrating so the preset hard break can publish",
				});
		} catch {}
	} else if (fs.existsSync(targetWorkflow)) {
		try {
			const document = JSON.parse(fs.readFileSync(targetWorkflow, "utf8"));
			const count = presetCount(document);
			if (count > 0) {
				actions.push({
					kind: "strip-presets",
					from: targetWorkflow,
					to: targetWorkflow,
					stripPresets: true,
				});
				presetsRemoved += count;
			}
		} catch {}
	}

	// 2. Environment configuration assets.
	let sourceEntries: fs.Dirent[] = [];
	try {
		sourceEntries = fs.readdirSync(sourceEnvRoot, { withFileTypes: true });
	} catch {
		sourceEntries = [];
	}
	for (const entry of sourceEntries) {
		const from = path.join(sourceEnvRoot, entry.name);
		if (entry.name === ".DS_Store") continue;
		if ((RUNTIME_ENTRIES as readonly string[]).includes(entry.name)) {
			skipped.push({ path: from, reason: "runtime data; stays in place" });
			continue;
		}
		if (!(MIGRATED_ENV_ASSETS as readonly string[]).includes(entry.name)) {
			skipped.push({
				path: from,
				reason: "unrecognized entry; review it by hand rather than moving it",
			});
			continue;
		}
		const to = path.join(targetRoot, entry.name);
		if (isSymlink(from)) {
			conflicts.push({
				kind: "symlink",
				detail: `${from} is a symlink`,
				resolution: "copy the link target in place, then rerun the preview",
			});
			continue;
		}
		if (entry.isDirectory()) {
			for (const file of listFiles(from)) {
				const relative = path.relative(sourceEnvRoot, file);
				const destination = path.join(targetRoot, relative);
				if (fs.existsSync(destination)) {
					if (sha256(file) !== sha256(destination))
						conflicts.push({
							kind: "existing-target",
							detail: `${relative} exists in both roots with different content`,
							resolution: `keep one copy by hand (target: ${destination})`,
						});
					continue;
				}
				actions.push({ kind: "copy-asset", from: file, to: destination });
			}
			continue;
		}
		if (entry.name === ".env") {
			const sourceVars = loadEnvFile(from);
			const targetExists = fs.existsSync(to);
			const targetVars = targetExists
				? loadEnvFile(to)
				: new Map<string, string>();
			let conflict = false;
			for (const [key, value] of sourceVars) {
				secretKeyNames.add(key);
				const existing = targetVars.get(key);
				if (existing !== undefined && existing !== value) {
					conflict = true;
					conflicts.push({
						kind: "env-value",
						detail: `${key} is set to different values in ${from} and ${to}`,
						resolution:
							"choose the value to keep by hand; values are never printed or auto-merged",
					});
				}
			}
			if (conflict) continue;
			// Only keys the target is missing are added; unrelated target lines and
			// every existing target value survive. An already-covering target needs no
			// action at all.
			if (!targetExists) actions.push({ kind: "copy-asset", from, to });
			else {
				const missing = [...sourceVars.keys()].filter(
					(key) => !targetVars.has(key),
				);
				if (missing.length) actions.push({ kind: "merge-env", from, to });
			}
			continue;
		}
		if (fs.existsSync(to)) {
			if (sha256(from) !== sha256(to))
				conflicts.push({
					kind: "existing-target",
					detail: `${entry.name} exists in both roots with different content`,
					resolution: `keep one copy by hand (target: ${to})`,
				});
			continue;
		}
		actions.push({ kind: "copy-asset", from, to });
	}

	// 3. Provider credentials still stored in clear text move into the protected
	// `.env` and leave a reference behind. Planned last so the pairs land on top of
	// whatever the `.env` copy or merge already wrote.
	const providersSourceDir = path.join(sourceEnvRoot, "providers");
	const providersTargetDir = path.join(targetRoot, "providers");
	const credentialSlots = new Map<string, string>();
	let providerEntries: fs.Dirent[] = [];
	try {
		providerEntries = fs.readdirSync(providersSourceDir, {
			withFileTypes: true,
		});
	} catch {
		providerEntries = [];
	}
	const envTarget = path.join(targetRoot, ".env");
	const envVars = fs.existsSync(envTarget) ? loadEnvFile(envTarget) : new Map();
	const sourceEnvVars = fs.existsSync(path.join(sourceEnvRoot, ".env"))
		? loadEnvFile(path.join(sourceEnvRoot, ".env"))
		: new Map<string, string>();
	for (const entry of providerEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const from = path.join(providersSourceDir, entry.name);
		const to = path.join(providersTargetDir, entry.name);
		let extraction: ReturnType<typeof extractionFor>;
		try {
			extraction = extractionFor(from);
		} catch {
			// An unparseable provider file is copied as-is; the store reports it.
			continue;
		}
		for (const field of extraction.suspicious)
			conflicts.push({
				kind: "suspicious-field",
				detail: `${entry.name} has a credential-looking field ${JSON.stringify(field)} that is not part of the provider contract`,
				resolution:
					"review the file by hand: move a real secret into the root .env and reference it, or confirm the value is safe to keep",
			});
		const pairs = extraction.extraction?.envPairs;
		if (pairs === undefined || pairs.size === 0) continue;
		let conflicted = false;
		for (const [key, value] of pairs) {
			secretKeyNames.add(key);
			const existing = envVars.get(key) ?? sourceEnvVars.get(key);
			if (existing !== undefined && existing !== value) {
				conflicted = true;
				conflicts.push({
					kind: "env-value",
					detail: `${key} (from ${entry.name}) already has a different value in the root .env`,
					resolution:
						"keep the value already in .env, or remove it so the provider file's value can move in",
				});
			}
		}
		// A second provider sanitizing to the same slot would share a credential.
		for (const [key] of pairs) {
			const owner = credentialSlots.get(key);
			if (owner !== undefined && owner !== entry.name)
				conflicts.push({
					kind: "duplicate-ident",
					detail: `${entry.name} and ${owner} both map to credential slot ${key}`,
					resolution:
						"rename one provider so each owns a distinct credential slot",
				});
			credentialSlots.set(key, entry.name);
		}
		if (conflicted) continue;
		// The credential-bearing file is written by the extraction, not copied.
		const copyIndex = actions.findIndex(
			(action) => action.kind === "copy-asset" && action.to === to,
		);
		if (copyIndex >= 0) actions.splice(copyIndex, 1);
		actions.push({
			kind: "extract-credentials",
			from,
			to,
			envPairs: pairs,
			envTarget,
		});
	}

	// 4. Duplicate definition idents across the merged configuration.
	const sourceIdents = definitionIdents(sourceEnvRoot);
	const targetIdents = definitionIdents(targetRoot);
	for (const [ident, fingerprint] of sourceIdents) {
		const existing = targetIdents.get(ident);
		if (
			existing !== undefined &&
			existing.split(":")[1] !== fingerprint.split(":")[1]
		)
			conflicts.push({
				kind: "duplicate-ident",
				detail: `definition ident ${JSON.stringify(ident)} exists in both roots (${fingerprint.split(":")[0]}, ${existing.split(":")[0]})`,
				resolution:
					"delete or rename one definition so the catalog keeps stable identities",
			});
	}

	return {
		sourceEnvRoot,
		targetRoot,
		actions,
		conflicts,
		skipped,
		secretKeyNames: [...secretKeyNames].sort(),
		presetsRemoved,
		pendingJournal: fs.existsSync(migrationJournalPath(targetRoot)),
	};
}

interface JournalTarget {
	readonly path: string;
	/** Protected backup of the file that was replaced, when one existed. */
	readonly backup?: string;
	readonly sha256: string;
}

interface MigrationJournal {
	readonly version: number;
	readonly state: "preparing" | "published";
	readonly createdAt: string;
	readonly targetRoot: string;
	readonly backupDir: string;
	readonly sources: readonly { path: string; sha256: string }[];
	targets: readonly JournalTarget[];
	readonly secretKeys: readonly string[];
	/** Stored presets the strip-presets action deleted (absent on legacy
	 * journals, treated as 0). */
	readonly presetsRemoved?: number;
}

function writeJournal(journal: MigrationJournal): void {
	const file = migrationJournalPath(journal.targetRoot);
	fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`, {
		mode: 0o600,
	});
	fs.chmodSync(file, 0o600);
}

function readJournal(root: string): MigrationJournal {
	return JSON.parse(
		fs.readFileSync(migrationJournalPath(root), "utf8"),
	) as MigrationJournal;
}

/** Human-readable, value-free preview. */
export function formatMigrationPlan(plan: MigrationPlan): string {
	const lines: string[] = [];
	lines.push("Configuration migration preview");
	lines.push(`  source root: ${plan.sourceEnvRoot}`);
	lines.push(`  target root: ${plan.targetRoot}`);
	lines.push("");
	lines.push(`Changes (${plan.actions.length}):`);
	for (const action of plan.actions) {
		const verb =
			action.kind === "convert-workflow"
				? "convert"
				: action.kind === "merge-env"
					? "merge  "
					: action.kind === "extract-credentials"
						? "extract"
						: action.kind === "strip-presets"
							? "strip  "
							: "copy   ";
		lines.push(`  ${verb} ${action.from} -> ${action.to}`);
	}
	if (plan.actions.length === 0) lines.push("  (nothing to do)");
	if (plan.presetsRemoved > 0) {
		lines.push("");
		lines.push(
			`Removed ${plan.presetsRemoved} presets; recreate them as model pools in Settings \u2192 Presets.`,
		);
	}
	if (plan.secretKeyNames.length) {
		lines.push("");
		lines.push(
			`Credential variables moved by name only (${plan.secretKeyNames.length}): ${plan.secretKeyNames.join(", ")}`,
		);
	}
	if (plan.skipped.length) {
		lines.push("");
		lines.push(`Left in place (${plan.skipped.length}):`);
		for (const skip of plan.skipped)
			lines.push(`  ${skip.path}: ${skip.reason}`);
	}
	if (plan.conflicts.length) {
		lines.push("");
		lines.push(`Conflicts requiring a decision (${plan.conflicts.length}):`);
		for (const conflict of plan.conflicts)
			lines.push(
				`  [${conflict.kind}] ${conflict.detail}\n      -> ${conflict.resolution}`,
			);
	}
	lines.push("");
	lines.push(
		plan.conflicts.length
			? "Resolve every conflict before running `agentic-coding config migrate --apply`."
			: plan.actions.length
				? "Run `agentic-coding config migrate --apply` with all writers stopped to publish this plan."
				: "Configuration is already migrated.",
	);
	return `${lines.join("\n")}\n`;
}

export interface ApplyResult {
	readonly applied: number;
	readonly backupDir?: string;
	/** Stored agent presets deleted by this migration. */
	readonly presetsRemoved: number;
}

/**
 * Publish a plan. Every source is fingerprinted and copied into the protected
 * backup first; each target is written to a sibling `.staged` file and only
 * renamed into place during publication, so a failure before publication leaves
 * the live configuration unchanged. The journal blocks configuration reads while
 * a publication is incomplete.
 */
export function applyMigration(plan: MigrationPlan): ApplyResult {
	if (plan.conflicts.length)
		throw new Error(
			`${plan.conflicts.length} configuration conflict(s) must be resolved before applying; run the preview for details`,
		);
	if (fs.existsSync(migrationJournalPath(plan.targetRoot)))
		throw new Error(
			`an incomplete migration journal already exists at ${plan.targetRoot}; run \`agentic-coding config migrate --resume\` or \`--rollback\``,
		);
	if (plan.actions.length === 0) return { applied: 0, presetsRemoved: 0 };

	fs.mkdirSync(plan.targetRoot, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = path.join(plan.targetRoot, BACKUP_DIR_NAME, stamp);
	const sourceBackups = path.join(backupDir, "sources");
	const targetBackups = path.join(backupDir, "targets");
	for (const directory of [backupDir, sourceBackups, targetBackups]) {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		fs.chmodSync(directory, 0o700);
	}

	const journal: MigrationJournal = {
		version: JOURNAL_VERSION,
		state: "preparing",
		createdAt: new Date().toISOString(),
		targetRoot: plan.targetRoot,
		backupDir,
		sources: plan.actions.map((action) => ({
			path: action.from,
			sha256: sha256(action.from),
		})),
		targets: [],
		secretKeys: plan.secretKeyNames,
		presetsRemoved: plan.presetsRemoved,
	};
	writeJournal(journal);

	// One journal entry per published path. A path written by more than one
	// action (the target `.env` of a copy/merge plus a credential extraction) is
	// recorded once, with the backup taken before its first change. Sources may
	// live outside the target root, so backup names are indexed rather than
	// nested — a relative path would escape the backup directory.
	const targets = new Map<string, JournalTarget>();
	const recordTarget = (
		livePath: string,
		contentSha: string,
		label: string,
	): void => {
		const existing = targets.get(livePath);
		if (existing !== undefined) {
			targets.set(livePath, { ...existing, sha256: contentSha });
			return;
		}
		if (!fs.existsSync(livePath)) {
			// Nothing to restore: rollback removes a file the migration created.
			targets.set(livePath, { path: livePath, sha256: contentSha });
			return;
		}
		const backup = path.join(targetBackups, label);
		fs.copyFileSync(livePath, backup);
		fs.chmodSync(backup, 0o600);
		targets.set(livePath, { path: livePath, backup, sha256: contentSha });
	};

	try {
		for (const [index, action] of plan.actions.entries()) {
			const staged = `${action.to}.staged`;
			fs.mkdirSync(path.dirname(staged), { recursive: true });
			if (isSymlink(action.to))
				throw new Error(
					`refusing to replace the symlink ${action.to}; replace it with a regular file by hand`,
				);

			if (action.kind === "convert-workflow") {
				const raw = fs.readFileSync(action.from, "utf8");
				const document = parseConfigDocument(action.from, raw);
				const jsonText = `${JSON.stringify(document, null, 2)}\n`;
				// Effective non-secret parity: the JSON form must deep-merge to the
				// exact configuration the TOML produced. A value only TOML can express
				// (a date, a non-finite number) changes the result and is refused.
				const before = deepMergeConfig(
					structuredClone(DEFAULT_CONFIG),
					document,
				);
				const after = deepMergeConfig(
					structuredClone(DEFAULT_CONFIG),
					JSON.parse(jsonText) as Record<string, unknown>,
				);
				if (stableJson(before) !== stableJson(after))
					throw new Error(
						`converting ${action.from} would change the effective configuration; aborting without writing`,
					);
				if (action.stripPresets) stripPresets(document);
				fs.writeFileSync(staged, `${JSON.stringify(document, null, 2)}\n`, {
					mode: 0o600,
				});
				fs.chmodSync(staged, 0o600);
			} else if (action.kind === "strip-presets") {
				const document = JSON.parse(
					fs.readFileSync(action.from, "utf8"),
				) as Record<string, unknown>;
				stripPresets(document);
				fs.writeFileSync(staged, `${JSON.stringify(document, null, 2)}\n`, {
					mode: 0o600,
				});
				fs.chmodSync(staged, 0o600);
			} else if (action.kind === "merge-env") {
				// Only keys the target is missing are added; unrelated target lines and
				// every existing target value survive.
				fs.copyFileSync(action.to, staged);
				const sourceVars = loadEnvFile(action.from);
				const targetVars = loadEnvFile(action.to);
				upsertEnvFile(
					staged,
					new Map([...sourceVars].filter(([key]) => !targetVars.has(key))),
				);
			} else if (action.kind === "extract-credentials") {
				// The JSON keeps references; the literal values move to the protected
				// `.env` during publication, never into the staged JSON.
				const extraction = extractionFor(action.from);
				fs.writeFileSync(
					staged,
					`${JSON.stringify(extraction.extraction?.document, null, 2)}\n`,
					{ mode: 0o600 },
				);
				fs.chmodSync(staged, 0o600);
			} else {
				fs.copyFileSync(action.from, staged);
				const mode = fs.statSync(action.from).mode & 0o777;
				fs.chmodSync(
					staged,
					action.to.endsWith(".env") ? 0o600 : mode || 0o644,
				);
			}

			// Audit copy of every source, so the original configuration survives even
			// if the operator later edits or deletes the legacy files.
			const sourceBackup = path.join(
				sourceBackups,
				`${index}-${path.basename(action.from)}`,
			);
			fs.copyFileSync(action.from, sourceBackup);
			fs.chmodSync(sourceBackup, 0o600);
			recordTarget(
				action.to,
				sha256(staged),
				`${index}-${path.basename(action.to)}`,
			);
			if (action.envTarget)
				recordTarget(
					action.envTarget,
					sha256(staged),
					`${index}-${path.basename(action.envTarget)}`,
				);
			journal.targets = [...targets.values()];
			writeJournal(journal);
		}

		for (const action of plan.actions) {
			// The credential pairs land in the protected `.env` at publication time.
			// `upsertEnvFile` is itself atomic, so a crash here cannot truncate the
			// secrets file; the journal still records the path for rollback.
			if (
				action.kind === "extract-credentials" &&
				action.envPairs &&
				action.envTarget
			)
				upsertEnvFile(action.envTarget, action.envPairs);
			fs.renameSync(`${action.to}.staged`, action.to);
		}

		journal.targets = [...targets.values()];
		writeJournal({ ...journal, state: "published" });
		fs.rmSync(migrationJournalPath(plan.targetRoot), { force: true });
		return {
			applied: targets.size,
			backupDir,
			presetsRemoved: plan.presetsRemoved,
		};
	} catch (error) {
		rollbackMigration(plan.targetRoot);
		throw error;
	}
}

/**
 * Restore a consistent configuration after an interrupted publication. A
 * published file is only reverted when it still matches what the journal
 * recorded, so a later edit is never silently discarded.
 */
export function rollbackMigration(root: string): number {
	if (!fs.existsSync(migrationJournalPath(root))) return 0;
	const journal = readJournal(root);
	let restored = 0;
	for (const target of journal.targets) {
		fs.rmSync(`${target.path}.staged`, { force: true });
		if (!fs.existsSync(target.path)) continue;
		if (target.backup === undefined) {
			fs.rmSync(target.path, { force: true });
			restored += 1;
			continue;
		}
		// A file that no longer matches the journal was edited after publication;
		// keep it and leave the backup for the operator.
		if (fs.existsSync(target.backup) && sha256(target.path) === target.sha256) {
			fs.copyFileSync(target.backup, target.path);
			restored += 1;
		}
	}
	fs.rmSync(migrationJournalPath(root), { force: true });
	return restored;
}

/** Finish an interrupted publication by publishing every remaining staged file.
 * Reports how many stored presets the resumed publication stripped so the
 * caller can repeat the recreate-as-pools notification. */
export function resumeMigration(root: string): {
	published: number;
	presetsRemoved: number;
} {
	if (!fs.existsSync(migrationJournalPath(root)))
		return { published: 0, presetsRemoved: 0 };
	const journal = readJournal(root);
	let published = 0;
	for (const target of journal.targets) {
		const staged = `${target.path}.staged`;
		if (!fs.existsSync(staged)) continue;
		if (isSymlink(target.path))
			throw new Error(`refusing to replace the symlink ${target.path}`);
		fs.renameSync(staged, target.path);
		published += 1;
	}
	fs.rmSync(migrationJournalPath(root), { force: true });
	return { published, presetsRemoved: journal.presetsRemoved ?? 0 };
}
