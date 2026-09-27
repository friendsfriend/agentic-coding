// Bounded multiplexer boundary for developer-action notifications
// (workflow-developer-notifications).
//
// Two best-effort presentation writes through the selected `MultiplexerPort`:
//   - a needs-attention notification for the workflow transition;
//   - dashboard focus: list the workspace's tabs, resolve the workflow's
//     `dashboard` tab (ignoring its status glyph), then focus workspace + tab.
//
// Focus is a skip, never a failure: a missing workspace, missing dashboard
// tab, or missing tab id returns `false` and throws nothing. Notification
// transport errors still throw so the observer can report one bounded
// diagnostic; no partial side effect is produced by a failed call.

import { runMultiplexer } from "../multiplexer/boundary.ts";
import type { MultiplexerPort } from "../multiplexer/port.ts";
import { findAgentTabByBase } from "./tab-status.ts";

/** One bounded diagnostic sink for the whole notifier, never a flood. */
export interface NotificationDiagnostics {
	report(message: string): void;
}

/** The bounded delivery outcome. Every value counts as "raised"; the notifier
 * never retries a refused delivery in a loop. */
export type NotificationDelivery =
	| "shown"
	| "disabled"
	| "rate_limited"
	| "busy"
	| "no_foreground_client"
	| "refused"
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
	"refused",
	"unknown",
]);

/** Narrow a delivery envelope to a bounded outcome. An envelope that carries
 * no recognizable status (for example `{ shown: true }`) counts as `shown`,
 * and any unrecognized string is `unknown`. */
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
 * error and performs no other call. */
export async function showDeveloperNotification(
	port: MultiplexerPort,
	notification: DeveloperNotification,
	signal?: AbortSignal,
): Promise<NotificationDelivery> {
	signal?.throwIfAborted();
	const outcome = await runMultiplexer(
		port.notify({
			title: notification.title,
			body: notification.body,
			needsAttention: true,
		}),
	);
	return notificationDelivery({ delivery: outcome });
}

/**
 * Reject a store-sourced workspace identity that could confuse the runtime:
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
	port: MultiplexerPort,
	workspace: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!validWorkspaceIdentity(workspace)) return false;
	try {
		signal?.throwIfAborted();
		const tabs = await runMultiplexer(port.tabList(workspace));
		const dashboard = findAgentTabByBase(tabs, "dashboard");
		const tabId = dashboard?.tabId;
		if (!tabId) return false;
		await runMultiplexer(port.workspaceFocus(workspace));
		if (signal?.aborted) return false;
		await runMultiplexer(port.tabFocus(tabId));
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
	port: MultiplexerPort,
	notification: DeveloperNotification,
	workspace: string | undefined,
	signal?: AbortSignal,
): Promise<NotificationRaiseResult> {
	const focused =
		workspace && validWorkspaceIdentity(workspace)
			? await focusWorkflowDashboard(port, workspace, signal)
			: false;
	const delivery = await showDeveloperNotification(port, notification, signal);
	return { delivery, focused };
}

/** One bounded, non-secret diagnostic sink: identical repeats collapse, so a
 * persistent failure reports once per distinct message. */
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
