import { createSignal } from "solid-js";

/**
 * Shared, surface-agnostic error modal store. Operational errors are shown in
 * one blocking dialog rendered above every surface (dashboard, devenv, and
 * observability) instead of being printed inline in panel/status content, so
 * the user sees them even while another herdr tab is focused. Warnings and
 * informational messages stay on the corner toast (`Notification.tsx`).
 */
export type ErrorModalContent = { title: string; message: string };

const [activeErrorModal, setActiveErrorModal] =
	createSignal<ErrorModalContent>();

export { activeErrorModal };

export function showErrorModal(title: string, message: string) {
	setActiveErrorModal({ title, message });
}

export function dismissErrorModal() {
	setActiveErrorModal(undefined);
}

/** Clear any mounted error modal (test isolation: the signal is module-global). */
export function resetErrorModal() {
	setActiveErrorModal(undefined);
}
