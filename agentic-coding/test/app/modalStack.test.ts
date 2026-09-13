import { describe, expect, test } from "bun:test";
import {
	createModalStackState,
	findModal,
	modalOwnsInput,
	popModal,
	popModalById,
	pushModal,
	registerFocusRestorer,
	restoreFocus,
	restoreFocusTarget,
	topModal,
} from "../../src/tui/shared/modalStack";

type Kind = "help" | "review" | "theme";

describe("authoritative shell modal stack (compose-unified-feature-shell)", () => {
	test("a pushed overlay exclusively owns input; the root stack does not", () => {
		const root = createModalStackState<Kind>();
		expect(modalOwnsInput(root)).toBe(false);
		const review = pushModal(root, {
			kind: "review",
			restoreFocusTo: "workflow-detail",
		});
		expect(modalOwnsInput(review)).toBe(true);
		expect(topModal(review)?.kind).toBe("review");
		expect(restoreFocusTarget(review)).toBe("workflow-detail");
	});

	test("nested help over a review dialog is two instances and closing help reveals review", () => {
		const review = pushModal(createModalStackState<Kind>(), {
			kind: "review",
			restoreFocusTo: "workflow-detail",
		});
		const help = pushModal(review, { kind: "help" });
		expect(help.stack).toHaveLength(2);
		expect(topModal(help)?.kind).toBe("help");
		const revealed = popModal(help);
		expect(topModal(revealed)?.kind).toBe("review");
		expect(restoreFocusTarget(revealed)).toBe("workflow-detail");
		expect(modalOwnsInput(popModal(revealed))).toBe(false);
	});

	test("re-opening a singleton kind replaces it with a fresh instance id", () => {
		const once = pushModal(createModalStackState<Kind>(), { kind: "theme" });
		const firstId = topModal(once)?.id;
		const twice = pushModal(once, { kind: "theme" });
		expect(twice.stack).toHaveLength(1);
		expect(topModal(twice)?.id).not.toBe(firstId);
	});

	test("non-singleton kinds may stack distinct instances", () => {
		const once = pushModal(createModalStackState<Kind>(), {
			kind: "review",
			singleton: false,
		});
		const twice = pushModal(once, { kind: "review", singleton: false });
		expect(twice.stack).toHaveLength(2);
		expect(twice.stack[0]?.id).not.toBe(twice.stack[1]?.id);
	});

	test("popping the root stack is a stable no-op", () => {
		const root = createModalStackState<Kind>();
		expect(popModal(root)).toBe(root);
	});

	test("findModal locates a live instance below the top", () => {
		const review = pushModal(createModalStackState<Kind>(), { kind: "review" });
		const help = pushModal(review, { kind: "help" });
		expect(findModal(help, "review")?.kind).toBe("review");
		expect(findModal(help, "theme")).toBeUndefined();
	});

	test("popModalById removes the captured instance, not a newer overlay of the same kind", () => {
		// Keep both instances so the older id is actually present.
		const first = pushModal(createModalStackState<Kind>(), {
			kind: "theme",
			singleton: false,
		});
		const firstId = topModal(first)?.id ?? "";
		const second = pushModal(first, { kind: "theme", singleton: false });
		const secondId = topModal(second)?.id ?? "";
		expect(second.stack).toHaveLength(2);
		const after = popModalById(second, firstId);
		expect(after.stack).toHaveLength(1);
		expect(topModal(after)?.id).toBe(secondId);
		// Removing an unknown id is a stable no-op.
		expect(popModalById(after, firstId)).toBe(after);
	});

	test("restoreFocus invokes the registered opener restorer and ignores unknown ids", () => {
		let restored = 0;
		const dispose = registerFocusRestorer("panel-a", () => {
			restored += 1;
		});
		expect(restoreFocus("panel-a")).toBe(true);
		expect(restored).toBe(1);
		expect(restoreFocus("missing")).toBe(false);
		dispose();
		expect(restoreFocus("panel-a")).toBe(false);
	});
});
