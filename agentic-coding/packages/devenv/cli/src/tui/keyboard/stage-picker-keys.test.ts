import { describe, expect, test } from "bun:test";
import { handleStagePickerKeys } from "./stage-picker-keys.ts";
import type { KeyboardActions, KeyboardStores } from "./types.ts";

// The picker's key map (`open-stage-from-environments`): Escape clears the filter
// before it closes the dialog, `j`/`k` (and the arrows) move, `/` starts
// filtering, Enter selects. The behaviour itself is the stage actions', so these
// cases assert which action a key reaches.

function setup(
	picker: { open?: boolean; filterActive?: boolean; query?: string } = {},
) {
	const state = {
		open: picker.open ?? true,
		filterActive: picker.filterActive ?? false,
		query: picker.query ?? "",
	};
	const calls: string[] = [];
	const stores = {
		appStore: {},
		issueStore: {},
		logStore: {},
		changeRequestStore: {},
		providerStore: {},
		agentStore: {},
		appDetailStore: {},
		actionRunStore: {},
		slotStore: {},
		uiStore: {
			showStagePicker: () => state.open,
			stagePickerFilterActive: () => state.filterActive,
			stagePickerQuery: () => state.query,
		},
	} as unknown as KeyboardStores;
	const actions = {
		stageActions: {
			close: () => calls.push("close"),
			clearFilter: () => calls.push("clearFilter"),
			activateFilter: () => calls.push("activateFilter"),
			setFilter: (query: string) => calls.push(`filter:${query}`),
			move: (delta: number) => calls.push(`move:${delta}`),
			confirm: () => calls.push("confirm"),
		},
	} as unknown as KeyboardActions;
	return { stores, actions, calls, state };
}

describe("stage picker keys", () => {
	test("escape closes the dialog when nothing is filtered", () => {
		const { stores, actions, calls } = setup();
		expect(handleStagePickerKeys({ name: "escape" }, stores, actions)).toBe(
			true,
		);
		expect(calls).toEqual(["close"]);
	});

	test("escape clears the filter first, then closes", () => {
		const filtered = setup({ filterActive: true, query: "prod" });
		handleStagePickerKeys(
			{ name: "escape" },
			filtered.stores,
			filtered.actions,
		);
		expect(filtered.calls).toEqual(["clearFilter"]);

		const typed = setup({ query: "prod" });
		handleStagePickerKeys({ name: "escape" }, typed.stores, typed.actions);
		expect(typed.calls).toEqual(["clearFilter"]);
	});

	test("j/k and the arrows move the cursor", () => {
		const { stores, actions, calls } = setup();
		handleStagePickerKeys({ name: "j" }, stores, actions);
		handleStagePickerKeys({ name: "down" }, stores, actions);
		handleStagePickerKeys({ name: "k" }, stores, actions);
		handleStagePickerKeys({ name: "up" }, stores, actions);
		expect(calls).toEqual(["move:1", "move:1", "move:-1", "move:-1"]);
	});

	test("enter selects", () => {
		const { stores, actions, calls } = setup();
		handleStagePickerKeys({ name: "return" }, stores, actions);
		expect(calls).toEqual(["confirm"]);
	});

	test("/ starts filtering, typing extends the query, backspace trims it", () => {
		const { stores, actions, calls, state } = setup();
		handleStagePickerKeys({ name: "/" }, stores, actions);
		expect(calls).toEqual(["activateFilter"]);

		state.filterActive = true;
		state.query = "pro";
		handleStagePickerKeys({ name: "d" }, stores, actions);
		// The store owns the query; the recorded write is what it would hold.
		state.query = "prod";
		handleStagePickerKeys({ name: "backspace" }, stores, actions);
		expect(calls).toEqual(["activateFilter", "filter:prod", "filter:pro"]);
	});

	test("a closed picker leaves the key to the dialog chain", () => {
		const { stores, actions, calls } = setup({ open: false });
		expect(handleStagePickerKeys({ name: "j" }, stores, actions)).toBe(false);
		expect(calls).toEqual([]);
	});
});
