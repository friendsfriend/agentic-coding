/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import {
	activeModalHelp,
	GenericModal,
	handleModalHelpKey,
	ModalHelpOverlay,
	modalHelpOpen,
	withModalHelpKeybind,
} from "@ui";
import { onCleanup } from "solid-js";

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

test("a dialog's `?` help can scroll to the appended Mouse rows", async () => {
	// A catalog longer than the overlay's line budget, so the clamp is what
	// decides whether the shared Mouse section is reachable at all.
	const entries = Array.from({ length: 20 }, (_, index) => ({
		key: `k${index}`,
		action: `action ${index}`,
	}));
	function LongProbe() {
		keyLayer({ onKey: (key) => handleModalHelpKey(key) });
		return (
			<>
				<GenericModal
					title="Long dialog"
					help={entries}
					widthPercent={0.9}
					heightPercent={0.9}
				>
					<text>body</text>
				</GenericModal>
				<ModalHelpOverlay />
			</>
		);
	}
	const t = await testRender(() => <LongProbe />, { width: 80, height: 14 });
	await t.flush();
	t.mockInput.pressKey("?");
	await t.waitForFrame((frame) => frame.includes("Actions"));
	// Scroll to the end: the last rows are the shared Mouse section, and the
	// clamp counts them (helpModalRowCount), so they must be reachable.
	for (let index = 0; index < 40; index += 1) {
		t.mockInput.pressKey("j");
		await t.flush();
	}
	const frame = t.captureCharFrame();
	expect(frame).toContain("Mouse");
	expect(frame).toContain("wheel");
	t.renderer.destroy();
});
