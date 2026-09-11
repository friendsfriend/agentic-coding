/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { GenericModal } from "../../src/tui/dash/ui/GenericModal";
import { ModalHelpOverlay } from "../../src/tui/shared/ModalHelpOverlay";
import {
	activeModalHelp,
	handleModalHelpKey,
	modalHelpOpen,
	withModalHelpKeybind,
} from "../../src/tui/shared/modalHelp";

function keyLayer(props: { onKey?: (key: string) => boolean }) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayer({
		name: "modal-help-probe",
		priority: 1,
		commands: [
			{
				name: "modal-help.handle",
				run: ({ event }) => props.onKey?.(event.name.toLowerCase()) ?? false,
			},
		],
		bindings: ["?", "j", "k", "up", "down", "escape"].map((key) => ({
			key,
			cmd: "modal-help.handle",
		})),
	});
	onCleanup(dispose);
}

function HelpProbe() {
	keyLayer({ onKey: (key) => handleModalHelpKey(key) });
	return (
		<>
			<GenericModal
				title="Cost breakdown"
				help={[
					{ key: "j/k", action: "Navigate" },
					{ key: "Enter", action: "Message detail" },
					{ key: "Esc", action: "Close" },
				]}
			>
				<text>cost body</text>
			</GenericModal>
			<ModalHelpOverlay />
		</>
	);
}

function StackedProbe() {
	keyLayer({ onKey: (key) => handleModalHelpKey(key) });
	return (
		<>
			{/* A dialog that fills the terminal and portals above the default
			    z-order, mirroring DeveloperQuestionModal's zIndex={20}. */}
			<GenericModal
				title="High dialog"
				widthPercent={0.98}
				heightPercent={0.98}
				zIndex={20}
				help={[{ key: "Esc", action: "Close" }]}
			>
				<text>high body</text>
			</GenericModal>
			<ModalHelpOverlay zIndex={30} />
		</>
	);
}

test("withModalHelpKeybind appends `? help` once and never mutates input", () => {
	const entries = [{ key: "Esc", action: "Close" }];
	const withHelp = withModalHelpKeybind(entries);
	expect(withHelp.map((entry) => entry.key)).toEqual(["Esc", "?"]);
	expect(entries).toHaveLength(1);
	// An existing `?` entry is respected, not duplicated.
	const already = [{ key: "?", action: "Get help" }];
	expect(withModalHelpKeybind(already)).toEqual(already);
	// Empty footers get no automatic help affordance.
	expect(withModalHelpKeybind([])).toEqual([]);
});

test("a modal advertises `? help` and opens the shared help modal with its keybinds", async () => {
	const t = await testRender(() => <HelpProbe />, { width: 80, height: 30 });
	await t.flush();
	const modal = t.captureCharFrame();
	expect(modal).toContain("Cost breakdown");
	expect(modal).toContain("Message detail");
	expect(modal).toContain("? help");

	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((frame) => frame.includes("Keybindings"));
	// The overlay renders the modal's full actions, not the footer short forms.
	expect(help).toContain("Navigate");
	expect(help).toContain("Message detail");

	// Esc closes the overlay without closing the modal underneath.
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	const closed = await t.waitForFrame(
		(frame) => !frame.includes("Keybindings"),
	);
	expect(closed).toContain("Cost breakdown");
	expect(modalHelpOpen()).toBe(false);
	t.renderer.destroy();
	expect(activeModalHelp()).toBeUndefined();
});

test("the help overlay stacks above a higher-zIndex dialog", async () => {
	const t = await testRender(() => <StackedProbe />, { width: 80, height: 30 });
	await t.flush();

	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((frame) => frame.includes("Keybindings"));
	// The full-bleed dialog (zIndex 20) must not paint over the help overlay.
	expect(help).toContain("Keybindings");
	expect(help).toContain("Open help");

	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	const closed = await t.waitForFrame(
		(frame) => !frame.includes("Keybindings"),
	);
	expect(closed).toContain("High dialog");
	t.renderer.destroy();
});
