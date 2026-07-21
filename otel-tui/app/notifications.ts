import { createSignal } from 'solid-js';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';
type NotificationItem = { message: string; type: NotificationType };

const [activeNotification, setActiveNotification] = createSignal<NotificationItem | undefined>();

export { activeNotification };

export function notify(message: string, type: NotificationType = 'info') {
  setActiveNotification({ message, type });
  setTimeout(() => setActiveNotification(), 3000);
}
