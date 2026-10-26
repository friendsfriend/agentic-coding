/** @jsxImportSource @opentui/solid */
// Shared corner toast rendering (src/tui/shared/Notification.tsx) fed by the
// dashboard notification store.

import { NotificationOverlay as SharedNotificationOverlay } from "@agentic-coding/ui";
import { activeNotification, dismissNotification } from "../notifications.ts";

export function NotificationOverlay() {
	return (
		<SharedNotificationOverlay
			active={activeNotification}
			onDismiss={dismissNotification}
		/>
	);
}
