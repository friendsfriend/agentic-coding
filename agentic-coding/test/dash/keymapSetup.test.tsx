/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { setupKeymap } from "../../src/tui/dash/keymap-setup";

function TestKeymap(props: { errors: string[] }) {
	const keymap = createDefaultOpenTuiKeymap(useRenderer());
	const disposeError = keymap.on("error", ({ code }) =>
		props.errors.push(code),
	);
	const disposeKeymap = setupKeymap(keymap);
	onCleanup(() => {
		disposeKeymap();
		disposeError();
	});
	return <box />;
}

test("dashboard keymap adds no duplicate default fields", async () => {
	const errors: string[] = [];
	const t = await testRender(() => <TestKeymap errors={errors} />);
	await t.flush();
	expect(errors).toEqual([]);
	t.renderer.destroy();
});
