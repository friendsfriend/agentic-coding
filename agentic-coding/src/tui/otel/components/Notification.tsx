/** @jsxImportSource @opentui/solid */
// Shared corner toast rendering (src/tui/shared/Notification.tsx) fed by the
// observability notification store.

import { NotificationOverlay as SharedNotificationOverlay } from "../../shared/Notification";
import { activeNotification } from "../app/notifications";

export function NotificationOverlay() {
	return <SharedNotificationOverlay active={activeNotification} />;
}
