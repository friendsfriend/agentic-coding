import { describe, expect, test } from "bun:test";
import { createAppStore } from "../stores/app-store.ts";
import { getActiveModalName } from "./keymap-runtime.ts";
import type { KeyboardStores } from "./types.ts";

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
		uiStore: signalStore({
			showMarkdownModal: () => Boolean(open.markdown),
			showConfirmDialog: () => Boolean(open.confirm),
		}),
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

	test("a dialog opened from a dialog is on top, whatever the kind order", () => {
		const appStore = createAppStore();
		// `markdown` ranks above `confirm` in the fixed flag list; a confirm opened
		// *from* the markdown modal must still own the top of the stack, so the
		// first Escape closes confirm and the next closes markdown.
		const markdown = stores(appStore, { markdown: true });
		expect(getActiveModalName(markdown)).toBe("markdown");
		const child = stores(appStore, { markdown: true, confirm: true });
		expect(getActiveModalName(child)).toBe("confirm");
		expect(appStore.modalStack().map((route) => route.name)).toEqual([
			"markdown",
			"confirm",
		]);
		// Closing the child reveals the parent as the active dialog again.
		expect(getActiveModalName(markdown)).toBe("markdown");
		expect(appStore.modalStack().map((route) => route.name)).toEqual([
			"markdown",
		]);
	});

	test("the parent flag cannot take the key back from the child on top", () => {
		const appStore = createAppStore();
		// `handleGlobalKeys` dispatches the modal the runtime reports first, so the
		// parent's higher rank in the fixed order cannot win while the child is on
		// top: the reported name is the child's.
		const open = stores(appStore, { markdown: true, confirm: true });
		expect(getActiveModalName(open)).toBe("confirm");
		expect(getActiveModalName(open)).not.toBe("markdown");
	});
});
