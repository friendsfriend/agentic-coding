import { expect, test } from "bun:test";
import { createActionRunStore } from "../stores/action-run-store";
import { handleActionsKeys } from "./actions-keys";

type ActionsKeyEvent = Parameters<typeof handleActionsKeys>[0];
type ActionsAppStore = Parameters<typeof handleActionsKeys>[2];

const key = (event: {
	name: string;
	shift?: boolean;
	sequence?: string;
}): ActionsKeyEvent => event as unknown as ActionsKeyEvent;

const makeAppStore = (): ActionsAppStore =>
	({ popModal: () => undefined }) as unknown as ActionsAppStore;

test("Shift+J/K switches action panels and j/k uses focused panel", () => {
	const store = createActionRunStore();
	store.handleEvent("action.started", {
		run: {
			id: "r",
			title: "Run",
			status: "active",
			steps: [
				{ id: "a", label: "A", status: "pending", commands: [] },
				{ id: "b", label: "B", status: "pending", commands: [] },
			],
		},
	});
	const appStore = makeAppStore();
	handleActionsKeys(key({ name: "J", shift: true }), store, appStore);
	expect(store.focusedPanel()).toBe(1);
	handleActionsKeys(key({ name: "K", shift: true }), store, appStore);
	expect(store.focusedPanel()).toBe(0);
	const scrolledTo: number[] = [];
	store.treeScrollBoxRef = {
		scrollTo: (position: number) => {
			scrolledTo.push(position);
		},
	} as unknown as NonNullable<typeof store.treeScrollBoxRef>;
	handleActionsKeys(key({ name: "j" }), store, appStore);
	expect(store.focusedStepId()).toBe("a");
	expect(scrolledTo).toEqual([2]);
	handleActionsKeys(key({ name: "down" }), store, appStore);
	expect(store.focusedStepId()).toBe("b");
	handleActionsKeys(key({ name: "up" }), store, appStore);
	expect(store.focusedStepId()).toBe("a");
});

test("g/G and n/p navigate action rows", () => {
	const store = createActionRunStore();
	for (const id of ["first", "second", "third"]) {
		store.handleEvent("action.started", {
			run: { id, title: id, status: "completed", steps: [] },
		});
	}
	const appStore = makeAppStore();

	handleActionsKeys(key({ name: "p" }), store, appStore);
	expect(store.selectedRunId()).toBe("second");
	handleActionsKeys(key({ name: "n" }), store, appStore);
	expect(store.selectedRunId()).toBe("third");
	handleActionsKeys(key({ name: "g" }), store, appStore);
	expect(store.selectedRunId()).toBe("first");
	handleActionsKeys(key({ name: "G", shift: true }), store, appStore);
	expect(store.selectedRunId()).toBe("third");
});

test("y copies focused tree node with all descendant log content", () => {
	const store = createActionRunStore();
	store.handleEvent("action.started", {
		run: {
			id: "r",
			title: "Run",
			action: "run",
			targetLabel: "app",
			status: "completed",
			steps: [
				{
					id: "parent",
					label: "Start dependency: db",
					status: "completed",
					commands: [],
				},
				{
					id: "child",
					parentId: "parent",
					label: "Start containers",
					status: "completed",
					commands: [
						{
							id: "cmd",
							command: "podman-compose up -d",
							status: "completed",
							stdout: "ready\n",
							stderr: "",
							exitCode: 0,
						},
					],
				},
			],
		},
	});
	store.focusStep("parent");
	let copied = "";
	const handled = handleActionsKeys(
		key({ name: "y", sequence: "y" }),
		store,
		makeAppStore(),
		undefined,
		undefined,
		async (text) => {
			copied = text;
			return true;
		},
	);
	expect(handled).toBe(true);
	expect(copied).toContain("▾ ✓ Start dependency: db");
	expect(copied).toContain("    ✓ Start containers");
	expect(copied).toContain("$ podman-compose up -d");
});
