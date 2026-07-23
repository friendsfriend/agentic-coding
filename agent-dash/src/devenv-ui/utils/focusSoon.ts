export function focusSoon(target: { focus: () => void } | undefined | null) {
  if (!target) return;
  // OpenTUI renderables may not be focusable until next tick after mount.
  setTimeout(() => target.focus(), 0);
}
