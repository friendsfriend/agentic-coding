// Delivery push credential preflight (efficiency backlog item 16): one cheap,
// non-interactive question asked before `delivery.push` spawns a push it cannot
// win. A push that cannot authenticate used to be attempted, retried unchanged
// through the durable outbox, and attempted again — every attempt spent the same
// seconds and reproduced the same failure, so the developer saw a repeated
// monitor note instead of one actionable block.
//
// The check is deliberately fail-open. Only a *positive* authentication failure
// blocks; a timeout, a DNS failure, a refused connection, a repository that is
// not there, or anything else the check cannot interpret returns `inconclusive`
// and the push proceeds exactly as before, because a preflight must never block
// a push that would have succeeded. Two cases are skipped rather than guessed
// at: a remote that is a local path needs no credential at all, and a push whose
// command can ask the developer for a credential itself (the dashboard's
// passphrase popup) may succeed in a way a non-interactive check cannot
// reproduce.
//
// Nothing here prints or persists key material: a URL's userinfo password is
// masked, known credential shapes are redacted, and only one bounded, matched
// error line is reported.
import { Effect, Result } from "effect";
import { redactTelemetryText } from "./observability.ts";
import { runProcessEffect } from "./process.ts";

/** How long the credential check may take. Short: it runs on the delivery path,
 * and `inconclusive` is a safe outcome anyway. */
export const PUSH_PREFLIGHT_TIMEOUT_MS = 10_000;
/** `git ls-remote` prints one line per branch; the bound keeps a pathological
 * remote from filling the capture. */
export const PUSH_PREFLIGHT_MAX_OUTPUT_BYTES = 64 * 1024;
/** Bound for the two local git questions the check asks (remote URLs, ssh
 * command): both read configuration, neither reaches the network. */
const PUSH_PREFLIGHT_CONFIG_TIMEOUT_MS = 5_000;
/** The longest fragment this module reports in a note or a telemetry payload. */
const PUSH_PREFLIGHT_TEXT_LIMIT = 300;

/** The *positive* authentication failures. Everything else — a timeout, an
 * unknown host, a refused connection, a missing repository, or git's own
 * "terminal prompts disabled" (which an interactive push answers with a
 * credential prompt) — must not block a push, so this list is an allowlist of
 * recognized verdicts rather than a blocklist of errors. */
const PUSH_AUTH_FAILURE_SIGNALS: readonly RegExp[] = [
	/permission denied \((?:publickey|password|keyboard-interactive)/i,
	/authentication failed/i,
	/invalid username or password/i,
	/access denied/i,
];

export type PushPreflightOutcome =
	/** The remote accepted this machine's credentials. */
	| "ok"
	/** A positive authentication failure: the push cannot succeed unchanged. */
	| "auth-failed"
	/** The check proved nothing either way (timeout, network, unknown error). */
	| "inconclusive"
	/** The push itself may ask for a credential, so the check was skipped. */
	| "skipped-interactive"
	/** The remote is a local path, which needs no credential. */
	| "skipped-local"
	/** No remote to check (none configured, or no such remote in this repos). */
	| "skipped-no-remote";

export interface PushPreflightResult {
	readonly outcome: PushPreflightOutcome;
	/** The remote as configured: a name such as `origin`, or a URL. */
	readonly remote: string;
	/** The URL a push would use, masked and bounded — safe to show and to emit
	 * to telemetry. Equal to `remote` when no URL could be resolved. */
	readonly label: string;
	/** The matched authentication failure line, or the check's own failure. */
	readonly detail?: string;
	readonly durationMs: number;
}

export interface PushPreflightInput {
	/** The repository the push would run in; resolves a remote *name*. */
	readonly cwd: string;
	/** The configured delivery remote (a name or a URL). */
	readonly remote: string;
	readonly signal?: AbortSignal;
	/** Whether the push itself can ask the developer for a credential (the
	 * dashboard's popup). When it can, a non-interactive verdict is not evidence
	 * about that push, so the check is skipped instead of blocking it. */
	readonly interactive?: boolean;
	/** Overridden only so a test can bound the check without waiting. */
	readonly timeoutMs?: number;
}

/** The first line that reads as a positive authentication failure, bounded, or
 * `undefined` when the output proves nothing either way. */
export function pushAuthFailureSignal(output: string): string | undefined {
	for (const line of output.split("\n")) {
		const candidate = line.trim();
		if (candidate === "") continue;
		for (const pattern of PUSH_AUTH_FAILURE_SIGNALS)
			if (pattern.test(candidate)) return bound(candidate);
	}
	return undefined;
}

/** Whether `git push` accepts this value as a URL rather than as a configured
 * remote name: a scheme (`ssh://`, `https://`, `git://`) or the scp-like
 * `user@host:path`. */
export function isGitRemoteUrl(value: string): boolean {
	const candidate = value.trim();
	return (
		/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) ||
		/^[^/@\s]+@[^/:\s]+:/.test(candidate)
	);
}

/** Whether this remote is a local path. A local remote needs no credential, so
 * a credential check against it would say nothing true about a network push. */
export function isLocalPathRemote(value: string): boolean {
	const candidate = value.trim();
	if (candidate === "") return false;
	if (/^file:\/\//i.test(candidate)) return true;
	return !isGitRemoteUrl(candidate);
}

/** The remote as it may be shown or emitted: a URL's userinfo password is
 * masked, a known credential shape is redacted, and the value is bounded. An
 * ssh URL's user (`git@host:path`) is not a secret and is kept. */
export function redactRemoteLabel(value: string): string {
	const masked = value.trim().replace(/(\/\/[^/@\s]+):[^/@\s]*@/g, "$1:***@");
	return bound(redactTelemetryText(masked));
}

export interface PushAuthFailure {
	/** The remote the workflow is configured to push to (a name or a URL). */
	readonly remote: string;
	/** The URL the push would use, as the preflight reported it. */
	readonly label: string;
	/** The matched authentication failure line. */
	readonly signal: string;
	/** Whether the push was stopped before it ran, or after it had run. */
	readonly source: "preflight" | "push";
}

/** One actionable line naming what failed and how to fix it, with no key
 * material, passphrase, or token in it. This becomes the failed effect's
 * `lastError` and the workflow's attention note. */
export function pushAuthFailureNote(input: PushAuthFailure): string {
	const remote = redactRemoteLabel(input.remote);
	const label = redactRemoteLabel(input.label);
	const where =
		label !== "" && label !== remote
			? `${label} (remote ${remote})`
			: label || remote;
	const attempted =
		input.source === "preflight"
			? "the push was not attempted"
			: "the push did not land";
	return `delivery could not authenticate to ${where}: ${bound(redactTelemetryText(input.signal))}. ${attempted} and the effect is not retried unchanged; unlock the key the remote accepts (ssh-add -l lists what is loaded), fix the stored credential, or retry the delivery push to answer a credential prompt.`;
}

/** The ssh command git would use for this check, with `BatchMode=yes` appended
 * so it can never prompt. A command, wrapper, or key path the user configured
 * (GIT_SSH_COMMAND, then `core.sshCommand`, then GIT_SSH — git's own order) is
 * preserved rather than replaced: replacing it would fail the check for a push
 * that would have worked. */
export function pushPreflightSshCommand(
	env: Record<string, string | undefined>,
	configured: string | undefined,
): string {
	const base =
		env.GIT_SSH_COMMAND?.trim() ||
		configured?.trim() ||
		env.GIT_SSH?.trim() ||
		"ssh";
	return `${base} -o BatchMode=yes`;
}

/** The environment the check runs with: the process environment without any
 * askpass relay or prompt permission (a check has nobody to ask, and an askpass
 * helper it cannot answer would only fail the check), plus the non-interactive
 * ssh command and the transport allowlist a delivery push carries too. */
export function pushPreflightEnv(
	env: Record<string, string | undefined>,
	sshCommand: string,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (key === "GIT_ASKPASS" || key === "SSH_ASKPASS") continue;
		if (key === "SSH_ASKPASS_REQUIRE") continue;
		if (key.startsWith("AGENTIC_CODING_ASKPASS")) continue;
		result[key] = value;
	}
	result.GIT_TERMINAL_PROMPT = "0";
	result.GIT_SSH_COMMAND = sshCommand;
	// A repository's own `url.<base>.insteadOf` rewrite must not turn the check
	// into arbitrary execution (`ext::`); the delivery push carries the same
	// allowlist.
	result.GIT_ALLOW_PROTOCOL = "https:ssh:git";
	return result;
}

function bound(value: string, limit = PUSH_PREFLIGHT_TEXT_LIMIT): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** The push URLs `git push <remote>` would use: the remote's configured push
 * URLs when it is a name, otherwise the URL itself. An unresolvable name yields
 * no URL, which the caller reports as "no remote". */
function pushRemoteUrlsEffect(
	input: PushPreflightInput,
	timeoutMs: number,
): Effect.Effect<readonly string[], never, never> {
	return Effect.gen(function* () {
		const listed = yield* runProcessEffect(
			["git", "remote", "get-url", "--push", "--all", "--", input.remote],
			{
				cwd: input.cwd,
				signal: input.signal,
				timeoutMs: Math.min(timeoutMs, PUSH_PREFLIGHT_CONFIG_TIMEOUT_MS),
				maxOutputBytes: 16 * 1024,
			},
		).pipe(Effect.result);
		if (Result.isFailure(listed)) return [];
		return listed.success.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	});
}

/** The repository's `core.sshCommand`, when it has one. A failure (unset, or no
 * repository) folds into `undefined` rather than failing the check. */
function coreSshCommandEffect(
	input: PushPreflightInput,
	timeoutMs: number,
): Effect.Effect<string | undefined, never, never> {
	return runProcessEffect(["git", "config", "--get", "core.sshCommand"], {
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: Math.min(timeoutMs, PUSH_PREFLIGHT_CONFIG_TIMEOUT_MS),
		maxOutputBytes: 8 * 1024,
	}).pipe(
		Effect.map((result) => result.stdout.trim() || undefined),
		Effect.catch(() => Effect.succeed(undefined)),
	);
}

/** Ask one cheap, non-interactive question — does this machine hold a
 * credential the delivery remote accepts? — and answer with a verdict the
 * `delivery.push` handler can act on. Never fails: the check's own failure is
 * an outcome (`inconclusive`), not an error, because it must not stop a push. */
export function pushPreflightEffect(
	input: PushPreflightInput,
): Effect.Effect<PushPreflightResult, never, never> {
	const timeoutMs = input.timeoutMs ?? PUSH_PREFLIGHT_TIMEOUT_MS;
	return Effect.gen(function* () {
		const startedAt = Date.now();
		const settle = (
			outcome: PushPreflightOutcome,
			extra: { label?: string; detail?: string } = {},
		): PushPreflightResult => ({
			outcome,
			remote: input.remote,
			label: redactRemoteLabel(extra.label ?? input.remote),
			...(extra.detail ? { detail: bound(extra.detail) } : {}),
			durationMs: Date.now() - startedAt,
		});
		if (input.remote.trim() === "") return settle("skipped-no-remote");
		// A push that may ask the developer for a credential can succeed through
		// that answer; deciding against it non-interactively would block a push
		// that would have worked (the dashboard's passphrase popup).
		if (input.interactive === true) return settle("skipped-interactive");
		const resolved = yield* pushRemoteUrlsEffect(input, timeoutMs);
		const urls =
			resolved.length > 0
				? resolved
				: isGitRemoteUrl(input.remote)
					? [input.remote]
					: [];
		// No remote at all, or a name this repository does not have: the push
		// reports that itself and there is no credential question to answer.
		if (urls.length === 0) return settle("skipped-no-remote");
		const remoteUrl = urls[0] ?? input.remote;
		if (urls.every(isLocalPathRemote))
			return settle("skipped-local", { label: remoteUrl });
		const sshCommand = pushPreflightSshCommand(
			process.env,
			yield* coreSshCommandEffect(input, timeoutMs),
		);
		const checked = yield* runProcessEffect(
			// The URL a push would use, not the remote's name: `ls-remote <name>`
			// resolves the *fetch* URL, which a `pushurl` can differ from, and a
			// verdict about a URL the push never touches is exactly the false block
			// this check must not produce. When a remote has several push URLs, the
			// first is the one checked.
			["git", "ls-remote", "--heads", "--", remoteUrl],
			{
				cwd: input.cwd,
				env: pushPreflightEnv(process.env, sshCommand),
				signal: input.signal,
				timeoutMs,
				maxOutputBytes: PUSH_PREFLIGHT_MAX_OUTPUT_BYTES,
			},
		).pipe(Effect.result);
		if (Result.isSuccess(checked)) return settle("ok", { label: remoteUrl });
		const failure = checked.failure;
		const signal = pushAuthFailureSignal(failure.detail);
		if (signal)
			return settle("auth-failed", { label: remoteUrl, detail: signal });
		return settle("inconclusive", {
			label: remoteUrl,
			detail: `${failure._tag}: ${failure.detail}`,
		});
	});
}
