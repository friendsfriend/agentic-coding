import { createSignal } from "solid-js";
import { traceTui } from "../../dash/tracing";

export type NotificationType = "info" | "success" | "warning" | "error";
type NotificationItem = { message: string; type: NotificationType };

const [activeNotification, setActiveNotification] = createSignal<
	NotificationItem | undefined
>();

let timer: ReturnType<typeof setTimeout> | undefined;

export { activeNotification };

export function notify(message: string, type: NotificationType = "info") {
	setActiveNotification({ message, type });
	// Every toast is telemetered, but the free-form message never reaches a span;
	// only the bounded notification kind and surface do.
	traceTui(
		"tui.notification",
		{ surface: "observability", action: "notify", kind: type },
		type === "error" ? "error" : "ok",
	);
	clearTimeout(timer);
	timer = setTimeout(() => {
		timer = undefined;
		setActiveNotification();
	}, 3000);
}

/** Clear any mounted toast and its pending auto-clear timer (test isolation). */
export function resetNotifications() {
	clearTimeout(timer);
	timer = undefined;
	setActiveNotification();
}
