// The one configuration-root resolver (unify-json-configuration-directory,
// task 2.1). Every application-owned global configuration consumer resolves its
// root here, so no reader keeps an independent default path.
//
// Precedence: explicit argument -> AGENTIC_CODING_CONFIG_DIR -> deprecated
// DEVENV_CONFIG_DIR -> ~/.config/agentic-coding. The legacy variable selects the
// same single root, never a second authority. Root selection never reads the
// root's `.env`, so a `.env` cannot decide which directory contains it.
//
// This lives in the `root` source layer because runtime, TUI-shared and
// TUI-feature modules all resolve the root and may only share root-layer code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root-changing keys that are ignored when they appear in a root `.env`. */
export const ROOT_SELECTING_ENV_KEYS = [
	"AGENTIC_CODING_CONFIG_DIR",
	"DEVENV_CONFIG_DIR",
] as const;

export const LEGACY_CONFIG_ROOT_VAR = "DEVENV_CONFIG_DIR";
export const CONFIG_ROOT_VAR = "AGENTIC_CODING_CONFIG_DIR";

/** The environment shape the resolver reads. Index-signature-compatible with
 * `process.env` so a caller can inject the real environment or a fixture. */
export type ConfigRootEnv = Readonly<Record<string, string | undefined>>;

export interface ResolvedConfigRoot {
	/** Absolute, normalized root. */
	readonly path: string;
	/** Which input won, for Settings provenance. Never contains a secret. */
	readonly source: string;
}

export function defaultConfigRoot(home = os.homedir()): string {
	return path.join(home, ".config", "agentic-coding");
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Pure precedence resolution. Split out so Settings can report the effective
 * source from an injected environment without duplicating the order.
 */
export function configRootFrom(
	env: ConfigRootEnv,
	explicit?: string,
	home = os.homedir(),
): ResolvedConfigRoot {
	const explicitRoot = nonEmpty(explicit);
	if (explicitRoot !== undefined)
		return { path: path.resolve(explicitRoot), source: "explicit argument" };
	const canonical = nonEmpty(env[CONFIG_ROOT_VAR]);
	if (canonical !== undefined)
		return { path: path.resolve(canonical), source: CONFIG_ROOT_VAR };
	const legacy = nonEmpty(env[LEGACY_CONFIG_ROOT_VAR]);
	if (legacy !== undefined)
		return {
			path: path.resolve(legacy),
			source: `${LEGACY_CONFIG_ROOT_VAR} (deprecated)`,
		};
	return {
		path: defaultConfigRoot(home),
		source: "default (~/.config/agentic-coding)",
	};
}

let legacyWarningEmitted = false;

/** Once-per-process, value-free deprecation diagnostic: it names the variable
 * and never the path, so a deprecation report cannot leak a configuration
 * location or anything read from it. */
export function warnLegacyConfigRoot(): void {
	if (legacyWarningEmitted) return;
	legacyWarningEmitted = true;
	process.stderr.write(
		`[config] ${LEGACY_CONFIG_ROOT_VAR} is deprecated; use ${CONFIG_ROOT_VAR}. ${LEGACY_CONFIG_ROOT_VAR} still selects the single active configuration root.\n`,
	);
}

/** Ignore-and-report a root-selecting key found inside a root `.env`. */
export function warnRootSelectingKeyInEnvFile(key: string): void {
	process.stderr.write(
		`[config] ignoring ${key} in .env: the configuration root is not selected by the root's own .env\n`,
	);
}

/** Reset the once-per-process diagnostic so tests can assert it. */
export function resetConfigRootDiagnostics(): void {
	legacyWarningEmitted = false;
}

/** Journal written by an in-progress configuration migration. Its presence
 * means the configuration authority is mid-cutover, so reads of a mixed
 * snapshot are refused until the migration resumes or rolls back. */
export const MIGRATION_JOURNAL_FILE = ".config-migration.json";

/** Absolute path of the migration journal for a root. */
export function migrationJournalPath(root: string): string {
	return path.join(root, MIGRATION_JOURNAL_FILE);
}

/**
 * Refuse to read a configuration whose migration is mid-cutover. A completed
 * migration removes its journal, so this is only true while published state is
 * known to be partial.
 */
export function assertNoPendingMigration(root: string): void {
	if (!fs.existsSync(migrationJournalPath(root))) return;
	throw new Error(
		`configuration migration at ${root} is incomplete; run \`agentic-coding config migrate --resume\` or \`--rollback\` before using this configuration`,
	);
}

/**
 * Resolve the single configuration root. `explicit` is a caller-supplied path
 * (migration `--source`/`--target`, health checks); it is normalized once so
 * every consumer and every child process sees the same absolute root.
 */
export function resolveConfigRoot(explicit?: string): string {
	const resolved = configRootFrom(process.env, explicit);
	// The deprecation is about the variable being consulted at all, so it is
	// reported even when the new name wins a both-set environment. An explicit
	// argument bypasses both variables, so there is nothing to deprecate.
	if (
		nonEmpty(explicit) === undefined &&
		nonEmpty(process.env[LEGACY_CONFIG_ROOT_VAR]) !== undefined
	)
		warnLegacyConfigRoot();
	return resolved.path;
}

/**
 * Environment fragment that makes a child process resolve the same root. Only
 * the resolved root is forwarded: the legacy alias is deliberately not passed
 * on, so a subprocess never re-emits the deprecation or reads a stale value.
 */
export function configRootEnv(root: string): Record<string, string> {
	return { [CONFIG_ROOT_VAR]: root };
}
