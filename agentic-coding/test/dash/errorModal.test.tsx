/** @jsxImportSource @opentui/solid */

import { beforeEach, expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import {
	activeErrorModal,
	ErrorModalOverlay,
	resetErrorModal,
	showErrorModal,
} from "@ui";
import { onCleanup } from "solid-js";

// The error-modal signal is module-global; bun runs all files in one process,
// so clear it before every render.
beforeEach(() => resetErrorModal());

function Harness() {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(dispose);
	return <ErrorModalOverlay keymap={keymap} />;
}

test("global error modal renders an operational error and dismisses on escape", async () => {
	const t = await testRender(() => <Harness />, { width: 90, height: 26 });
	await t.flush();

	showErrorModal("Invalid workflow state", "state.json is malformed");
	await t.flush();

	const frame = t.captureCharFrame();
	expect(frame).toContain("Invalid workflow state");
	expect(frame).toContain("state.json is malformed");

	t.mockInput.pressEscape();
	await Bun.sleep(80);
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("state.json is malformed");
	expect(activeErrorModal()).toBeUndefined();

	t.renderer.destroy();
});

test("resetErrorModal clears any mounted error", () => {
	showErrorModal("T", "M");
	resetErrorModal();
	expect(activeErrorModal()).toBeUndefined();
});
