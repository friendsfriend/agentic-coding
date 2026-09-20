/** @jsxImportSource @opentui/solid */
// Shared corner toast rendering (src/tui/shared/Notification.tsx) fed by the
// observability notification store.

import { NotificationOverlay as SharedNotificationOverlay } from "@ui";
import { activeNotification } from "../app/notifications.ts";

export function NotificationOverlay() {
	return <SharedNotificationOverlay active={activeNotification} />;
}
