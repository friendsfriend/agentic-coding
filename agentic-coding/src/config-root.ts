// The one configuration-root resolver (unify-json-configuration-directory,
// task 2.1). Every application-owned global configuration consumer resolves its
// root here, so no reader keeps an independent default path.
//
// Precedence: explicit argument -> AGENTIC_CODING_CONFIG_DIR ->
// ~/.config/agentic-coding. Root selection never reads the root's `.env`, so a
// `.env` cannot decide which directory contains it.
//
// This lives in the `root` source layer because runtime, TUI-shared and
// TUI-feature modules all resolve the root and may only share root-layer code.
import os from "node:os";
import path from "node:path";

/** Root-changing keys that are ignored when they appear in a root `.env`. */
export const ROOT_SELECTING_ENV_KEYS = ["AGENTIC_CODING_CONFIG_DIR"] as const;

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
	return {
		path: defaultConfigRoot(home),
		source: "default (~/.config/agentic-coding)",
	};
}

/** A configuration diagnostic is either a non-fatal warning (the configuration
 * is usable, something about it is worth reporting) or an error (the load
 * failed). */
export type ConfigDiagnosticKind = "warning" | "error";
export type ConfigDiagnosticSink = (
	message: string,
	kind: ConfigDiagnosticKind,
) => void;

let diagnosticSink: ConfigDiagnosticSink | undefined;

/**
 * Install the process-wide diagnostic sink and return a disposer. A rendering
 * surface installs one so a diagnostic becomes a toast or a blocking error
 * dialog instead of a raw stderr write, which would print into an OpenTUI
 * render. Without a sink (headless server, workflow CLI) diagnostics keep
 * going to stderr.
 */
export function setConfigDiagnosticSink(
	sink?: ConfigDiagnosticSink,
): () => void {
	diagnosticSink = sink;
	return () => {
		if (diagnosticSink === sink) diagnosticSink = undefined;
	};
}

/** Report a diagnostic. Value-free by contract: it names files and variables and
 * never the configuration values or secrets they hold. */
export function configDiagnostic(
	message: string,
	kind: ConfigDiagnosticKind = "warning",
): void {
	if (diagnosticSink) {
		diagnosticSink(message, kind);
		return;
	}
	process.stderr.write(`[config] ${message}\n`);
}

/** Ignore-and-report a root-selecting key found inside a root `.env`. */
export function warnRootSelectingKeyInEnvFile(key: string): void {
	configDiagnostic(
		`ignoring ${key} in .env: the configuration root is not selected by the root's own .env`,
	);
}

/**
 * Resolve the single configuration root. `explicit` is a caller-supplied path
 * (health checks); it is normalized once so every consumer and every child
 * process sees the same absolute root.
 */
export function resolveConfigRoot(explicit?: string): string {
	return configRootFrom(process.env, explicit).path;
}

/**
 * Environment fragment that makes a child process resolve the same root. Only
 * the resolved root is forwarded: the legacy alias is deliberately not passed
 * on, so a subprocess never re-emits the deprecation or reads a stale value.
 */
export function configRootEnv(root: string): Record<string, string> {
	return { [CONFIG_ROOT_VAR]: root };
}
