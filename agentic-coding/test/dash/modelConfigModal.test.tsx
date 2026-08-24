/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { ModelConfigModal } from "../../src/tui/dash/ui/ModelConfigModal";

/** Prepend a stub bin providing an instant fake `pi --list-models` so the
 * editor's model enumeration never spawns the real runtime under load. */
function stubPiOnPath(directory: string): () => void {
	const bin = path.join(directory, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const script = path.join(bin, "pi");
	fs.writeFileSync(script, '#!/bin/sh\necho "stub/stub-model"\n');
	fs.chmodSync(script, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous ?? ""}`;
	return () => {
		process.env.PATH = previous;
	};
}

function key(name: string): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: false,
		shift: false,
		option: false,
		sequence: name,
		number: false,
		raw: name,
		eventType: "press",
		source: "raw",
	});
}

test("model config modal shows profile and preset lists with help entry", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-modal-test-"));
	process.env.HERDR_WORKFLOW_CONFIG = path.join(dir, "config.toml");
	fs.writeFileSync(
		process.env.HERDR_WORKFLOW_CONFIG,
		'[ui]\ntheme = "catppuccin"\n',
	);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	try {
		const t = await testRender(
			() => (
				<ModelConfigModal
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
				/>
			),
			{ width: 90, height: 26 },
		);
		await t.flush();
		let frame = t.captureCharFrame();
		expect(frame).toContain("Model configuration");
		expect(frame).toContain("Profiles");
		expect(frame).toContain("Presets");
		expect(frame).toContain("comments in it are not preserved");
		handler?.(key("enter")); // open Profiles list
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).toContain("Agent profiles");
		expect(frame).toContain("(create new profile…)");
		handler?.(key("escape"));
		await t.flush();
		handler?.(key("down")); // menu -> Presets
		handler?.(key("enter"));
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).toContain("Agent presets");
		expect(frame).toContain("(create new preset…)");
		t.renderer.destroy();
	} finally {
		delete process.env.HERDR_WORKFLOW_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 20000);

test("profile editor walks name -> runtime -> model fields", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-modal-test-"));
	process.env.HERDR_WORKFLOW_CONFIG = path.join(dir, "config.toml");
	fs.writeFileSync(
		process.env.HERDR_WORKFLOW_CONFIG,
		'[ui]\ntheme = "catppuccin"\n',
	);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	let restorePath: () => void = () => {};
	try {
		const t = await testRender(
			() => (
				<ModelConfigModal
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
				/>
			),
			{ width: 100, height: 30 },
		);
		restorePath = stubPiOnPath(dir);
		await t.flush();
		handler?.(key("enter")); // Profiles
		await t.flush();
		handler?.(key("j")); // move to "(create new profile…)"
		handler?.(key("enter")); // create new profile
		await t.flush();
		let frame = t.captureCharFrame();
		expect(frame).toContain("Profile name");
		for (const char of "test-profile") handler?.(key(char));
		handler?.(key("return"));
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).toContain("Execution environment");
		handler?.(key("return")); // confirm pi
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).toMatch(/Model for pi/);
		// accepting the "(unset)" first option must store empty, never the literal
		handler?.(key("return"));
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).toContain("Thinking level");
		handler?.(key("return")); // (unset)
		await t.flush();
		const persisted = fs.readFileSync(
			process.env.HERDR_WORKFLOW_CONFIG,
			"utf8",
		);
		expect(persisted).toContain("test-profile");
		expect(persisted).not.toContain("(unset)");
		expect(persisted).not.toContain("model");
		t.renderer.destroy();
	} finally {
		restorePath();
		delete process.env.HERDR_WORKFLOW_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 20000);

test("deleting a profile requires explicit confirmation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-modal-test-"));
	process.env.HERDR_WORKFLOW_CONFIG = path.join(dir, "config.toml");
	fs.writeFileSync(
		process.env.HERDR_WORKFLOW_CONFIG,
		'[agents]\ndefault_profile = "doomed"\n\n[agents.profiles.doomed]\nruntime = "pi"\n\n[agents.profiles.free]\nruntime = "opencode"\n\n[agents.profiles.preset-used]\nruntime = "pi"\n\n[agents.presets.some]\ndefault_profile = "doomed"\n[agents.presets.some.steps]\n"core.plan" = "preset-used"\n',
	);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	try {
		const t = await testRender(
			() => (
				<ModelConfigModal
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
				/>
			),
			{ width: 100, height: 30 },
		);
		await t.flush();
		handler?.(key("enter")); // Profiles
		await t.flush();
		handler?.(key("d"));
		await t.flush();
		let frame = t.captureCharFrame();
		expect(frame).toContain("Delete profile?");
		expect(frame).toContain("doomed");
		// cancel keeps the profile
		handler?.(key("escape"));
		await t.flush();
		expect(
			fs.readFileSync(process.env.HERDR_WORKFLOW_CONFIG, "utf8"),
		).toContain("doomed");
		// confirming a referenced profile refuses deletion
		handler?.(key("d"));
		await t.flush();
		handler?.(key("y"));
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).not.toContain("Delete profile?");
		expect(
			fs.readFileSync(process.env.HERDR_WORKFLOW_CONFIG, "utf8"),
		).toContain("[agents.profiles.doomed]");
		// an unreferenced profile deletes after confirmation
		handler?.(key("j")); // -> free
		handler?.(key("d"));
		await t.flush();
		handler?.(key("enter")); // confirm via Enter also works
		await t.flush();
		expect(
			fs.readFileSync(process.env.HERDR_WORKFLOW_CONFIG, "utf8"),
		).not.toContain("[agents.profiles.free]");
		// listIndex still points where "free" was: now "preset-used". A profile
		// referenced by any preset is refused with an error.
		handler?.(key("d"));
		await t.flush();
		handler?.(key("y"));
		await t.flush();
		frame = t.captureCharFrame();
		expect(frame).not.toContain("Delete profile?");
		const persistedAfterPresetRefusal = fs.readFileSync(
			process.env.HERDR_WORKFLOW_CONFIG,
			"utf8",
		);
		expect(persistedAfterPresetRefusal).toContain(
			"[agents.profiles.preset-used]",
		);
		expect(persistedAfterPresetRefusal).toContain(
			'"core.plan" = "preset-used"',
		);
		t.renderer.destroy();
	} finally {
		delete process.env.HERDR_WORKFLOW_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
