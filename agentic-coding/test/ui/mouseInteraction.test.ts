// Unit tests for the shared pointer layer (`tui-mouse-interaction`): the pure
// rules are exercised with synthetic samples, no renderer involved.
import { expect, test } from "bun:test";
import {
	backdropDismiss,
	classifyPointerGesture,
	DIALOG_DISMISS_MODES,
	DOUBLE_TAP_WINDOW_MS,
	isDoubleTap,
	isExplicitDismiss,
	isPrimaryPointerButton,
	keybindChipRunnable,
	moveRowIndex,
	parseChipKey,
	type RowGestureState,
	resolveRowInteraction,
	useRowMouse,
	useWheelScroll,
	wheelStep,
} from "@ui";

test("a tap needs the same cell: a press that moved is a drag", () => {
	expect(classifyPointerGesture({ x: 4, y: 2 }, { x: 4, y: 2 })).toBe("tap");
	// One cell lower is a drag, never a tap: this is what protects text
	// selection and copy (`tui-clipboard-copy`).
	expect(classifyPointerGesture({ x: 4, y: 2 }, { x: 4, y: 3 })).toBe("drag");
	// A release with no press behind it is not a tap on this row.
	expect(classifyPointerGesture(undefined, { x: 4, y: 2 })).toBe("none");
	// Which row the pair belongs to is the row index the caller recorded; a
	// recreated row instance for the same index at the same cell is still a tap
	// (asserted through the renderer tests, where a window moves).
});

test("only the primary button is a gesture", () => {
	expect(isPrimaryPointerButton(0)).toBe(true);
	expect(isPrimaryPointerButton(1)).toBe(false); // middle
	expect(isPrimaryPointerButton(2)).toBe(false); // right
	expect(isPrimaryPointerButton(undefined)).toBe(false);
});

test("a tap selects, a tap on the selected row activates", () => {
	const first = resolveRowInteraction({
		index: 2,
		selectedIndex: 0,
		activatable: true,
		now: 1_000,
	});
	expect(first.action).toBe("select");
	const second = resolveRowInteraction({
		index: 2,
		selectedIndex: 2,
		activatable: true,
		now: 1_100,
	});
	expect(second.action).toBe("activate");
	// A row with no activation only ever selects (the keyboard has no `Enter`
	// action there either).
	expect(
		resolveRowInteraction({ index: 2, selectedIndex: 2, now: 1_200 }).action,
	).toBe("select");
	// No row under the tap.
	expect(
		resolveRowInteraction({ index: -1, selectedIndex: 0, now: 1_300 }).action,
	).toBe("none");
});

test("a double tap activates once, through the same rule the second tap takes", () => {
	const now = 5_000;
	const first = resolveRowInteraction({
		index: 1,
		selectedIndex: 0,
		activatable: true,
		now,
	});
	expect(first.action).toBe("select");
	expect(isDoubleTap(first.lastTap, 1, now + 120)).toBe(true);
	expect(isDoubleTap(first.lastTap, 1, now + DOUBLE_TAP_WINDOW_MS + 1)).toBe(
		false,
	);
	expect(isDoubleTap(first.lastTap, 4, now + 10)).toBe(false);
	// The second tap of a double tap lands on the now-selected row: activate,
	// exactly once (the record it returns is the next tap's baseline).
	const second = resolveRowInteraction({
		index: 1,
		selectedIndex: 1,
		activatable: true,
		lastTap: first.lastTap,
		now: now + 120,
	});
	expect(second.action).toBe("activate");
	expect(second.lastTap).toEqual({ index: 1, at: now + 120, activated: true });
	// A row the surface cannot activate is only selected, even when double
	// tapped: no activation is invented for it.
	expect(
		resolveRowInteraction({
			index: 1,
			selectedIndex: 0,
			lastTap: first.lastTap,
			now: now + 120,
		}).action,
	).toBe("select");
	// A third tap inside the window does not run the activation again: an
	// accidental double click cannot confirm twice.
	expect(
		resolveRowInteraction({
			index: 1,
			selectedIndex: 1,
			activatable: true,
			lastTap: second.lastTap,
			now: now + 200,
		}).action,
	).toBe("none");
	// After the window a fresh tap activates again (Enter pressed twice).
	expect(
		resolveRowInteraction({
			index: 1,
			selectedIndex: 1,
			activatable: true,
			lastTap: second.lastTap,
			now: (second.lastTap.at ?? 0) + DOUBLE_TAP_WINDOW_MS + 10,
		}).action,
	).toBe("activate");
});

test("the wheel step and the cursor move stay inside the list", () => {
	expect(wheelStep(undefined)).toBe(1);
	expect(wheelStep(-3)).toBe(3);
	expect(wheelStep(0)).toBe(1);
	expect(moveRowIndex(0, "down", 1, 5)).toBe(1);
	expect(moveRowIndex(4, "down", 1, 5)).toBe(4);
	expect(moveRowIndex(0, "up", 1, 5)).toBe(0);
	expect(moveRowIndex(2, "left", 2, 5)).toBe(0);
	expect(moveRowIndex(0, "down", 1, 0)).toBe(0);
});

/** Dialogs whose `Esc` is a non-destructive dismissal. */
const ESCAPE_PARITY = [
	"help",
	"theme-picker",
	"workflow-graph",
	"findings",
	"debug-requests",
	"cost",
	"location-picker",
	"list-picker",
	"filter",
	"sort",
	"markdown-viewer",
	"artifact-preview",
	"error-dialog",
	"agent-session-picker",
	"settings-picker",
	"review-files",
	"repair-target",
	"completed-action-picker",
	"plan-rejection",
	"user-action",
	"trace-detail",
	"metric-detail",
	"log-detail",
	"topology-detail",
] as const;

/**
 * Dialogs that keep an explicit control: unsaved draft, secret, typed answer,
 * running operation or an irreversible action. A backdrop tap here would commit
 * (repair, run, start, reject) or discard work, so it is refused.
 */
const EXPLICIT_ONLY = [
	"new-workflow",
	"developer-question",
	"credentials",
	"number-editor",
	"review",
	"comment",
	"quit-confirm",
	"delete-workflow",
	"close-reason",
	"confirm",
	"progress",
	"action-run",
	"passphrase",
	"task-add",
] as const;

test("the dismissal policy is one table: read-only dismisses, guarded keeps its control", () => {
	expect(backdropDismiss("help")).toBe(true);
	expect(backdropDismiss("cost")).toBe(true);
	expect(backdropDismiss("findings")).toBe(true);
	expect(backdropDismiss("debug-requests")).toBe(true);
	expect(backdropDismiss("list-picker")).toBe(true);
	expect(backdropDismiss("new-workflow")).toBe(false);
	expect(backdropDismiss("credentials")).toBe(false);
	expect(backdropDismiss("developer-question")).toBe(false);
	expect(backdropDismiss("number-editor")).toBe(false);
	expect(backdropDismiss("quit-confirm")).toBe(false);
	expect(backdropDismiss("confirm")).toBe(false);
	// State guard: a draft, a secret or a running operation is never dismissed,
	// whatever the dialog kind says.
	expect(backdropDismiss("help", { hasDraft: true })).toBe(false);
	expect(backdropDismiss("cost", { running: true })).toBe(false);
	expect(backdropDismiss("findings", { irreversible: true })).toBe(false);
	expect(isExplicitDismiss("new-workflow")).toBe(true);
	expect(isExplicitDismiss("help")).toBe(false);
	// The bands are pinned literally, so reclassifying a dialog breaks here: an
	// irreversible action is never reachable by a stray click on the backdrop.
	for (const kind of EXPLICIT_ONLY) expect(backdropDismiss(kind)).toBe(false);
	for (const kind of ESCAPE_PARITY) expect(backdropDismiss(kind)).toBe(true);
	// Every classified kind is in one of the two bands.
	const classified: string[] = Object.keys(DIALOG_DISMISS_MODES);
	expect([...ESCAPE_PARITY, ...EXPLICIT_ONLY].sort() as string[]).toEqual(
		classified.sort() as string[],
	);
});

test("a chip is a pointer target only for a single stroke", () => {
	expect(parseChipKey("Enter")).toEqual({
		name: "return",
		ctrl: false,
		shift: false,
		alt: false,
	});
	expect(parseChipKey("Esc")).toEqual({
		name: "escape",
		ctrl: false,
		shift: false,
		alt: false,
	});
	expect(parseChipKey("Ctrl+Shift+C")).toEqual({
		name: "c",
		ctrl: true,
		shift: true,
		alt: false,
	});
	expect(parseChipKey("Alt+Enter")).toEqual({
		name: "return",
		ctrl: false,
		shift: false,
		alt: true,
	});
	// A shifted letter is dispatched as the stroke the developer types.
	expect(parseChipKey("T")).toEqual({
		name: "t",
		ctrl: false,
		shift: true,
		alt: false,
	});
	expect(parseChipKey("?")).toEqual({
		name: "?",
		ctrl: false,
		shift: false,
		alt: false,
	});
	// Alternatives and phrases are not keys: the chip stays inert.
	expect(parseChipKey("j/k")).toBeUndefined();
	expect(parseChipKey("J/K/H/L")).toBeUndefined();
	expect(parseChipKey("PgUp/PgDn")).toBeUndefined();
	expect(parseChipKey("j/k or ↑/↓")).toBeUndefined();
	expect(parseChipKey("Meta+X")).toBeUndefined();
	expect(keybindChipRunnable({ key: "Enter", action: "Open" })).toBe(true);
	expect(keybindChipRunnable({ key: "j/k", action: "Move" })).toBe(false);
});

test("a pane that cannot act lets the wheel bubble instead of swallowing it", () => {
	const calls: string[] = [];
	const event = {
		scroll: { direction: "down" as const, delta: 1 },
		preventDefault: () => calls.push("preventDefault"),
		stopPropagation: () => calls.push("stopPropagation"),
	};
	// A windowed list with neither `onScroll` nor `onSelect` for the wheel.
	const idle = useWheelScroll({
		enabled: () => false,
		onScroll: (direction, delta) => calls.push(`scroll:${direction}:${delta}`),
	});
	idle.onMouseScroll(
		event as unknown as Parameters<typeof idle.onMouseScroll>[0],
	);
	expect(calls).toEqual([]);
	// A pane that can act handles it, once, and stops there.
	const busy = useWheelScroll({
		enabled: () => true,
		onScroll: (direction, delta) => calls.push(`scroll:${direction}:${delta}`),
	});
	busy.onMouseScroll(
		event as unknown as Parameters<typeof busy.onMouseScroll>[0],
	);
	expect(calls).toEqual(["scroll:down:1", "preventDefault", "stopPropagation"]);
});

test("a row index given as an accessor is resolved on every event", () => {
	// The row keeps its position in the list reaction (`index: () => index()`),
	// so a reordered list still resolves the row the pointer is over.
	let live = 2;
	const selected: number[] = [];
	const activated: number[] = [];
	const events: Array<{ type: string; button: number; x: number; y: number }> =
		[];
	const row = useRowMouse({
		index: () => live,
		selectedIndex: () => live,
		activatable: () => true,
		onSelect: (index) => selected.push(index),
		onActivate: (index) => activated.push(index),
	});
	const event = (type: string) => ({
		type,
		button: 0,
		x: 3,
		y: 1,
		stopPropagation: () => events.push({ type: "stop", button: 0, x: 0, y: 0 }),
	});
	row.onMouseDown(event("down") as never);
	live = 0; // the list reordered between the press and the release
	row.onMouseUp(event("up") as never);
	// The release resolved index 0 (the live one), not the pressed 2.
	expect(selected).toEqual([]);
	expect(activated).toEqual([0]);
});

test("two rows sharing a holder are never each other's double tap", () => {
	// Every `Selectable` row encodes index 0 (it renders one row), so a shared
	// gesture holder must use the row *instance* to tell rows apart: otherwise a
	// fast second tap on another row is mistaken for a double tap on the first.
	const event = (instance: unknown) => ({
		button: 0,
		x: 3,
		y: 1,
		currentTarget: instance,
	});
	const rows = [{ id: "a" }, { id: "b" }];

	// Two unselected rows: a fast tap on each selects that row (never activates).
	const selectGesture: RowGestureState = {};
	const selected: number[] = [];
	const activated: number[] = [];
	const selectRow = (_instance: unknown) =>
		useRowMouse({
			gesture: selectGesture,
			index: 0, // the shape `Selectable` uses
			selectedIndex: () => 1,
			activatable: () => true,
			onSelect: () => selected.push(0),
			onActivate: () => activated.push(0),
		});
	const firstTap = selectRow(rows[0]);
	firstTap.onMouseDown(event(rows[0]) as never);
	firstTap.onMouseUp(event(rows[0]) as never);
	const secondTap = selectRow(rows[1]);
	secondTap.onMouseDown(event(rows[1]) as never);
	secondTap.onMouseUp(event(rows[1]) as never);
	expect(selected).toEqual([0, 0]);
	expect(activated).toEqual([]);

	// Two selected rows: each tap activates its own row, even inside the window.
	const activateGesture: RowGestureState = {};
	const acts: unknown[] = [];
	const activateRow = (instance: unknown) =>
		useRowMouse({
			gesture: activateGesture,
			index: 0,
			selectedIndex: () => 0,
			activatable: () => true,
			onActivate: () => acts.push(instance),
		});
	const rowA = activateRow(rows[0]);
	rowA.onMouseDown(event(rows[0]) as never);
	rowA.onMouseUp(event(rows[0]) as never);
	const rowB = activateRow(rows[1]);
	rowB.onMouseDown(event(rows[1]) as never);
	rowB.onMouseUp(event(rows[1]) as never);
	expect(acts).toEqual([rows[0], rows[1]]);

	// Coming back to row A activates it again (the developer acted on A), and a
	// repeat tap on A inside the window then stays inert: one act per gesture.
	rowA.onMouseDown(event(rows[0]) as never);
	rowA.onMouseUp(event(rows[0]) as never);
	expect(acts).toEqual([rows[0], rows[1], rows[0]]);
	rowA.onMouseDown(event(rows[0]) as never);
	rowA.onMouseUp(event(rows[0]) as never);
	expect(acts).toEqual([rows[0], rows[1], rows[0]]);
});
