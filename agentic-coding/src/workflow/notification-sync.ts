// Bounded Herdr boundary for developer-action notifications
// (workflow-developer-notifications).
//
// Two best-effort presentation writes through the shared `HerdrPort`:
//   - `notification show <title> --body <body> --sound request`, the same
//     `herdr` CLI envelope every other workflow call parses;
//   - dashboard focus: `tab list --workspace` to resolve the workflow's
//     `dashboard` tab (ignoring its status glyph), then `workspace focus` and
//     `tab focus`.
//
// Focus is a skip, never a failure: a missing workspace, missing dashboard
// tab, or missing tab id returns `false` and throws nothing. Notification
// transport errors still throw so the observer can report one bounded
// diagnostic; no partial side effect is produced by a failed call.

import { decodeHerdrResult } from "../herdr-client.ts";
import type { HerdrPort } from "./adapters.ts";
import { tabListResult } from "./herdr-schema.ts";
import { findAgentTabByBase } from "./tab-status.ts";

/** One bounded diagnostic sink for the whole notifier, never a flood. */
export interface NotificationDiagnostics {
	report(message: string): void;
}

/** The bounded Herdr delivery outcome. Every value counts as "raised"; the
 * notifier never retries a refused delivery in a loop. */
export type NotificationDelivery =
	| "shown"
	| "disabled"
	| "rate_limited"
	| "busy"
	| "no_foreground_client"
	| "unknown";

export interface DeveloperNotification {
	title: string;
	body: string;
}

const KNOWN_DELIVERIES: ReadonlySet<string> = new Set([
	"shown",
	"disabled",
	"rate_limited",
	"busy",
	"no_foreground_client",
	"unknown",
]);

async function call(
	herdr: HerdrPort,
	args: string[],
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) throw new Error("notification call was cancelled");
	return herdr.callAsync ? herdr.callAsync(args, signal) : herdr.call(...args);
}

/** Narrow a `.result` envelope to a bounded delivery outcome. An envelope that
 * carries no recognizable status (for example `{ shown: true }`) counts as
 * `shown`, and any unrecognized string is `unknown`. */
export function notificationDelivery(result: unknown): NotificationDelivery {
	if (!result || typeof result !== "object") return "shown";
	const record = result as Record<string, unknown>;
	const raw = record.delivery ?? record.status ?? record.outcome;
	if (typeof raw !== "string") return "shown";
	const normalized = raw.toLowerCase();
	return KNOWN_DELIVERIES.has(normalized)
		? (normalized as NotificationDelivery)
		: "unknown";
}

/** Raise one needs-attention notification. A transport failure throws a bounded
 * error and performs no other Herdr call. */
export async function showDeveloperNotification(
	herdr: HerdrPort,
	notification: DeveloperNotification,
	signal?: AbortSignal,
): Promise<NotificationDelivery> {
	const result = await call(
		herdr,
		[
			"notification",
			"show",
			notification.title,
			"--body",
			notification.body,
			"--sound",
			"request",
		],
		signal,
	);
	return notificationDelivery(result);
}

/**
 * Reject a store-sourced workspace identity that could confuse the Herdr CLI:
 * empty, over-long, or carrying C0 control characters. Mirrors the identity
 * guard in `setReturnInProcess` (`server/operations/engine.ts`). A rejected
 * workspace is treated as a skipped focus.
 */
export function validWorkspaceIdentity(workspace: string | undefined): boolean {
	if (!workspace || workspace.length > 256) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters
	return !/[\x00-\x1f]/.test(workspace);
}

/**
 * Focus a workflow's dashboard tab as a bounded best-effort step. Returns
 * `true` only when both focus calls were issued; an invalid, missing, or
 * unresolvable workspace, a tab list without a base label `dashboard`, or a
 * tab without an id is a skipped focus (`false`). Never throws, so it can
 * never fail a notification.
 */
export async function focusWorkflowDashboard(
	herdr: HerdrPort,
	workspace: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!validWorkspaceIdentity(workspace)) return false;
	try {
		const tabs = decodeHerdrResult(
			tabListResult,
			await call(herdr, ["tab", "list", "--workspace", workspace], signal),
		);
		const dashboard = findAgentTabByBase(tabs.tabs ?? [], "dashboard");
		const tabId = dashboard?.tab_id;
		if (!tabId) return false;
		await call(herdr, ["workspace", "focus", workspace], signal);
		await call(herdr, ["tab", "focus", tabId], signal);
		return true;
	} catch {
		return false;
	}
}

/** One notification raise plus its bounded best-effort focus outcome. */
export interface NotificationRaiseResult {
	delivery: NotificationDelivery;
	focused: boolean;
}

/**
 * Focus the workflow dashboard and then raise the notification. Focus runs
 * first (design decision) so the toast is not suppressed by the tab that is
 * about to become active; custom notifications carry no target and are not
 * suppressed regardless. The delivery outcome is returned regardless of focus
 * success, so a focus failure never un-raises the notification. A missing or
 * invalid workspace is a skipped focus. A notification transport failure
 * throws; the caller owns the diagnostic.
 */
export async function raiseDeveloperNotification(
	herdr: HerdrPort,
	notification: DeveloperNotification,
	workspace: string | undefined,
	signal?: AbortSignal,
): Promise<NotificationRaiseResult> {
	const focused =
		workspace && validWorkspaceIdentity(workspace)
			? await focusWorkflowDashboard(herdr, workspace, signal)
			: false;
	const delivery = await showDeveloperNotification(herdr, notification, signal);
	return { delivery, focused };
}

/** One bounded, non-secret diagnostic sink: identical repeats collapse, so a
 * persistent Herdr failure reports once per distinct message. */
export class BoundedNotificationDiagnostics implements NotificationDiagnostics {
	private readonly seen = new Set<string>();
	constructor(private readonly sink: (message: string) => void = () => {}) {}
	report(message: string): void {
		const bounded = message.slice(0, 200);
		if (this.seen.has(bounded)) return;
		this.seen.add(bounded);
		this.sink(`workflow notifications: ${bounded}`);
	}
}
