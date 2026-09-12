import { describe, expect, test } from "bun:test";
import { createAppStore } from "../stores/app-store";
import { getActiveModalName } from "./keymap-runtime";
import type { KeyboardStores } from "./types";

const signalStore = (overrides: Record<string, unknown> = {}) =>
	new Proxy(overrides, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return () => false;
		},
	});

const stores = (
	appStore: ReturnType<typeof createAppStore>,
	open: Record<string, boolean>,
): KeyboardStores =>
	({
		appStore: Object.assign(appStore, { showFirstSteps: () => false }),
		issueStore: signalStore(),
		logStore: signalStore({ showLogModal: () => Boolean(open.log) }),
		changeRequestStore: signalStore({
			showDiffModal: () => Boolean(open.diff),
			showCommentModal: () => Boolean(open.comment),
		}),
		providerStore: signalStore(),
		uiStore: signalStore(),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	}) as unknown as KeyboardStores;

describe("modal stack runtime", () => {
	test("active modal follows top of open modal stack", () => {
		const appStore = createAppStore();
		expect(getActiveModalName(stores(appStore, { diff: true }))).toBe("diff");
		expect(
			getActiveModalName(stores(appStore, { diff: true, comment: true })),
		).toBe("comment");
		expect(appStore.modalStack().map((route) => route.name)).toEqual([
			"diff",
			"comment",
		]);
		expect(getActiveModalName(stores(appStore, { diff: true }))).toBe("diff");
		expect(appStore.modalStack().map((route) => route.name)).toEqual(["diff"]);
	});
});
