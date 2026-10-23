/**
 * The shared mouse interaction layer (`tui-mouse-interaction`): one definition
 * of what a tap, a double tap, a drag and a wheel event mean, composed by every
 * surface instead of re-invented per panel.
 *
 * - `clickSemantics.ts` — the pure rules (gesture classification, select vs
 *   activate, the wheel step), unit-tested without a renderer.
 * - `useRowMouse.ts` — the Solid binding for list rows; a list owns one
 *   gesture holder (`RowGestureState`) and passes it to the rows it renders.
 * - `useWheelScroll.ts` — the wheel binding for a pane's own scroll owner.
 * - `useHover.ts` — enter/leave feedback for a raised surface.
 * - `dismissPolicy.ts` — the data table of which dialogs a backdrop tap may
 *   dismiss.
 * - `useKeybindChips.ts` — key chips as pointer targets, dispatching the key
 *   itself so the keymap keeps deciding.
 * - `useModalBackdrop.ts` — backdrop dismissal that dispatches the dialog's own
 *   `Esc`, gated by the shared policy.
 */
export * from "./clickSemantics.ts";
export * from "./dismissPolicy.ts";
export * from "./useHover.ts";
export * from "./useKeybindChips.ts";
export * from "./useModalBackdrop.ts";
export * from "./useRowMouse.ts";
export * from "./useTap.ts";
export * from "./useWheelScroll.ts";
