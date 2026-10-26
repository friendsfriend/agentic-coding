/** @jsxImportSource @opentui/solid */
// Shared corner toast rendering (src/tui/shared/Notification.tsx) fed by the
// observability notification store.

import { NotificationOverlay as SharedNotificationOverlay } from "@agentic-coding/ui";
import {
	activeNotification,
	dismissNotification,
} from "../app/notifications.ts";

export function NotificationOverlay() {
	return (
		<SharedNotificationOverlay
			active={activeNotification}
			onDismiss={dismissNotification}
		/>
	);
}
