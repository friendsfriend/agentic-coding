import { createSignal } from "solid-js";
export type Notification = {
	message: string;
	type: "info" | "success" | "warning" | "error";
};
const [notification, setNotification] = createSignal<Notification>();
let timer: ReturnType<typeof setTimeout> | undefined;
export const activeNotification = notification;
export function notify(message: string, type: Notification["type"] = "info") {
	setNotification({ message, type });
	clearTimeout(timer);
	timer = setTimeout(
		() => setNotification(undefined),
		type === "error" ? 6000 : 2200,
	);
}

/** Clear any mounted notification and its pending auto-clear timer. Exists so
 * tests can isolate: bun runs all files in one process and this signal is
 * module-global, so a toast from an earlier file would bleed into later ones. */
export function resetNotifications() {
	clearTimeout(timer);
	timer = undefined;
	setNotification(undefined);
}
