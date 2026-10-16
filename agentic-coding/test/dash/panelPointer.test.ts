// The dashboard's pointer wiring for the panel grid: a tap focuses a panel
// (only while the grid is the visible body) and activating a row selects the
// row the pointer resolved *before* dispatching the panel's own `Enter`.
import { expect, spyOn, test } from "bun:test";
import { panelPointerHandlers } from "../../src/tui/dash/panel-pointer.ts";

test("a tap focuses the panel unless the agent-session page replaced the grid", () => {
	const active = { set: () => {} };
	const setActivePanel = spyOn(active, "set");
	let sessionOpen = false;
	const { focusPanelFromPointer } = panelPointerHandlers({
		setActivePanel,
		dispatchKey: () => true,
		agentSessionOpen: () => sessionOpen,
	});
	focusPanelFromPointer(6);
	expect(setActivePanel).toHaveBeenCalledTimes(1);
	expect(setActivePanel).toHaveBeenLastCalledWith(6);
	// The hidden grid behind the agent-session page takes no focus request.
	sessionOpen = true;
	focusPanelFromPointer(1);
	expect(setActivePanel).toHaveBeenCalledTimes(1);
});

test("activation selects the resolved row before dispatching Enter", () => {
	const order: string[] = [];
	const { activatePanelRow } = panelPointerHandlers({
		setActivePanel: () => {},
		dispatchKey: (label) => {
			order.push(`dispatch:${label}`);
			return true;
		},
		agentSessionOpen: () => false,
	});
	activatePanelRow((index) => order.push(`select:${index}`))(3);
	// The order matters: one gesture can never act on a row it did not name.
	expect(order).toEqual(["select:3", "dispatch:Enter"]);
});
