/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { uiColors } from '../ui/colors';
import { activeNotification } from '../app/notifications';

export function NotificationOverlay() {
  const n = activeNotification();
  if (!n) return null;
  const bg = n.type === 'success' ? uiColors.success : n.type === 'warning' ? uiColors.warning : n.type === 'error' ? uiColors.error : uiColors.info;
  const icon = n.type === 'success' ? '✓ ' : n.type === 'warning' ? '! ' : n.type === 'error' ? '✗ ' : 'ℹ ';
  return <box position="absolute" right={2} bottom={1} paddingLeft={2} paddingRight={2} backgroundColor={bg}><text fg={uiColors.bgBase} attributes={TextAttributes.BOLD}>{icon}{n.message}</text></box>;
}
