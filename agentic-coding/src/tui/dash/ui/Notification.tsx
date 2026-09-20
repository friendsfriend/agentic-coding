/** @jsxImportSource @opentui/solid */
// Shared corner toast rendering (src/tui/shared/Notification.tsx) fed by the
// dashboard notification store.

import { NotificationOverlay as SharedNotificationOverlay } from "@ui";
import { activeNotification } from "../notifications.ts";

export function NotificationOverlay() {
	return <SharedNotificationOverlay active={activeNotification} />;
}
