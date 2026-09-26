/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { activeKeybindCatalog, resetErrorModal } from "@ui";
import { createSignal, onCleanup } from "solid-js";
import { clearAgentConfigCache } from "../../src/tui/dash/agent-config-cache.ts";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/dash/notifications.ts";
import { AgentPresetsView } from "../../src/tui/settings/AgentPresetsView.tsx";
import { POOL_EDITOR_STEPS } from "../../src/tui/settings/agentPresets.ts";
import type { SettingsItem } from "../../src/tui/settings/items.ts";
import { pressEscapeAndSettle, renderUntil } from "./support/terminal.ts";

// The inline Agent Presets surface (rework-model-profiles-and-presets). Rendered
// checks: the menu, the list, `+` creating a blank form, validation errors,
// prefilled editing, reference-safe deletion and preset role coverage. Keys go
// through the real keymap layer the component registers, so the surface is
// exercised the way a terminal drives it.

let configDir: string;
let configFile: string;
const previousEnv = process.env.HERDR_WORKFLOW_CONFIG;

beforeEach(() => {
	resetErrorModal();
	resetNotifications();
	clearAgentConfigCache();
	configDir = mkdtempSync(join(tmpdir(), "agent-presets-view-"));
	configFile = join(configDir, "config.json");
	writeFileSync(configFile, "{}\n");
	process.env.HERDR_WORKFLOW_CONFIG = configFile;
});

afterEach(() => {
	resetErrorModal();
	if (previousEnv === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
	else process.env.HERDR_WORKFLOW_CONFIG = previousEnv;
	clearAgentConfigCache();
	fs.rmSync(configDir, { recursive: true, force: true });
});

async function renderView(
	options: {
		items?: SettingsItem[];
		onActivate?: (item: SettingsItem) => void;
		onCtrlS?: () => void;
	} = {},
) {
	const { onCtrlS, ...viewOptions } = options;
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			});
			const disposeCtrlSProbe = keymap.registerLayer({
				name: "agent-presets-ctrl-s-probe",
				priority: 1,
				commands: [
					{
						name: "agent-presets-ctrl-s-probe.handle",
						run: () => {
							onCtrlS?.();
							return true;
						},
					},
				],
				bindings: [{ key: "ctrl+s", cmd: "agent-presets-ctrl-s-probe.handle" }],
			});
			onCleanup(disposeCtrlSProbe);
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return <AgentPresetsView keymap={keymap} {...viewOptions} />;
		},
		{ width: 110, height: 30 },
	);
	await t.flush();
	await t.renderOnce();
	return t;
}

function wroteConfig(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<
		string,
		unknown
	>;
}

function saveWithEnter(t: Awaited<ReturnType<typeof renderView>>) {
	for (let index = 0; index < 100; index += 1) t.mockInput.pressTab();
	t.mockInput.pressEnter();
}

async function editText(
	t: Awaited<ReturnType<typeof renderView>>,
	value: string,
	backspaces = 0,
) {
	t.mockInput.pressKey("e");
	await t.renderOnce();
	for (let index = 0; index < backspaces; index += 1)
		t.mockInput.pressBackspace();
	for (const char of value) t.mockInput.pressKey(char);
	await pressEscapeAndSettle(t);
}

test("the + key opens a blank form and saving persists a new profile", async () => {
	let ctrlSPassedThrough = false;
	const t = await renderView({ onCtrlS: () => (ctrlSPassedThrough = true) });
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter(); // open Model profiles list
	await renderUntil(t, (frame) => frame.includes("No model profiles"));

	// The list publishes its own footer/`?` catalog, including the add key.
	const actions = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.action),
	);
	expect(actions).toContain("add entry");
	expect(actions).toContain("delete entry");

	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	expect(t.captureCharFrame()).toContain("Thinking level");
	const formBinds = activeKeybindCatalog().flatMap(
		(section) => section.keybinds,
	);
	const formActions = formBinds.map((keybind) => keybind.key);
	expect(formActions).toContain("h/l");
	expect(formActions).toContain("Space");
	expect(formActions).toContain("e");
	expect(formActions).toContain("Enter");
	expect(formActions).toContain("Backspace");
	expect(formBinds.find((keybind) => keybind.key === "Enter")?.action).toBe(
		"validate and save",
	);
	expect(formActions).not.toContain("Ctrl+S");

	// Ctrl+S no longer submits or closes the editor.
	t.mockInput.pressKey("s", { ctrl: true });
	await t.renderOnce();
	expect(ctrlSPassedThrough).toBe(true);
	expect(wroteConfig()).not.toHaveProperty("agents");
	expect(t.captureCharFrame()).toContain("Profile name");

	// Enter on the last field validates before writing.
	saveWithEnter(t);
	expect(
		await renderUntil(t, (frame) => frame.includes("Name is required")),
	).toBe(true);
	expect(wroteConfig()).not.toHaveProperty("agents");

	// Enter from the first field validates and saves whole draft.
	await editText(t, "fresh");
	t.mockInput.pressEnter();
	expect(
		await renderUntil(
			t,
			(frame) => frame.includes("fresh") && !frame.includes("Profile name"),
		),
	).toBe(true);
	const agents = wroteConfig().agents as {
		profiles: Record<string, { runtime: string }>;
	};
	expect(agents.profiles.fresh?.runtime).toBe("pi");
	t.renderer.destroy();
});

test("Enter on a list entry opens the form prefilled with its stored values", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: {
					"fast-model": { runtime: "opencode", model: "vendor/fast" },
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("fast-model"))).toBe(
		true,
	);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	const frame = t.captureCharFrame();
	expect(frame).toContain("fast-model");
	expect(frame).toContain("opencode");
	t.renderer.destroy();
});

test("renaming an unreferenced profile saves the new key and drops the old", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({ agents: { profiles: { old: { runtime: "pi" } } } })}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("old"))).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	await editText(t, "new", "old".length);
	saveWithEnter(t);
	expect(await renderUntil(t, (frame) => frame.includes("new"))).toBe(true);
	const profiles = (
		wroteConfig().agents as { profiles: Record<string, unknown> }
	).profiles;
	expect(profiles).toHaveProperty("new");
	expect(profiles).not.toHaveProperty("old");
	t.renderer.destroy();
});

test("renaming a referenced profile is refused in place", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				default_profile: "used",
				profiles: { used: { runtime: "pi" } },
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("used"))).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	await editText(t, "renamed", "used".length);
	saveWithEnter(t);
	expect(await renderUntil(t, (frame) => frame.includes("Cannot rename"))).toBe(
		true,
	);
	const profiles = (
		wroteConfig().agents as { profiles: Record<string, unknown> }
	).profiles;
	expect(profiles).toHaveProperty("used");
	expect(profiles).not.toHaveProperty("renamed");
	t.renderer.destroy();
});

test("a referenced profile cannot be deleted, an unreferenced one can", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				default_profile: "used",
				profiles: {
					used: { runtime: "pi" },
					free: { runtime: "opencode" },
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter(); // Model profiles list (sorted: free, used)
	expect(await renderUntil(t, (frame) => frame.includes("used"))).toBe(true);
	// Focus "used" (second) and delete: referenced by default_profile.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressKey("d");
	expect(
		await renderUntil(t, (frame) => frame.includes("Delete profile?")),
	).toBe(true);
	t.mockInput.pressKey("y");
	await t.renderOnce();
	expect(
		(wroteConfig().agents as { profiles: Record<string, unknown> }).profiles,
	).toHaveProperty("used");
	// "free" is unreferenced and deletes after confirmation.
	t.mockInput.pressKey("k"); // back to free
	await t.renderOnce();
	t.mockInput.pressKey("d");
	await renderUntil(t, (frame) => frame.includes("Delete profile?"));
	t.mockInput.pressKey("y");
	expect(
		await renderUntil(
			t,
			() =>
				!(
					wroteConfig().agents as {
						profiles: Record<string, unknown>;
					}
				).profiles.free,
		),
	).toBe(true);
	t.renderer.destroy();
});

test("preset pool subform adds a tagged profile from sorted choices", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: { profiles: { b: { runtime: "pi" }, a: { runtime: "pi" } } },
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressKey("j"); // Presets
	t.mockInput.pressEnter();
	expect(
		await renderUntil(t, (frame) => frame.includes("use-default-model")),
	).toBe(true);
	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	const formKeys = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.key),
	);
	expect(formKeys).toContain("Enter");
	expect(formKeys).not.toContain("Ctrl+S");
	await editText(t, "my-preset");
	t.mockInput.pressTab(); // default profile
	t.mockInput.pressTab(); // core.plan pool entries
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Pool core.plan entries");
	expect(
		activeKeybindCatalog()
			.flatMap((section) => section.keybinds)
			.find((keybind) => keybind.key === "Enter")?.action,
	).toBe("manage pool entries");
	t.mockInput.pressEnter();
	expect(
		await renderUntil(t, (frame) =>
			frame.includes("No profile tags configured"),
		),
	).toBe(true);
	const poolBinds = activeKeybindCatalog().flatMap(
		(section) => section.keybinds,
	);
	expect(poolBinds.map((keybind) => keybind.action)).toContain("add entry");
	expect(poolBinds.map((keybind) => keybind.action)).toContain("move entry");
	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Profile tag"))).toBe(
		true,
	);
	await editText(t, "quick");
	t.mockInput.pressTab(); // sorted profile selector
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame.indexOf("○ a")).toBeLessThan(frame.indexOf("○ b"));
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j"); // select b after the empty choice
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("○ b");
	t.mockInput.pressKey(" ");
	t.mockInput.pressEnter(); // save the pool entry
	expect(await renderUntil(t, (frame) => frame.includes("quick"))).toBe(true);
	expect(t.captureCharFrame()).toContain("b");
	expect(
		await pressEscapeAndSettle(t, (frame) => frame.includes("Preset name")),
	).toBe(true);
	t.mockInput.pressKey("k");
	await t.renderOnce();
	t.mockInput.pressKey("k");
	await t.renderOnce();
	t.mockInput.pressEnter(); // save preset from its name field
	expect(await renderUntil(t, (frame) => frame.includes("my-preset"))).toBe(
		true,
	);
	const preset = (
		wroteConfig().agents as {
			presets: Record<string, { pools?: Record<string, unknown[]> }>;
		}
	).presets["my-preset"];
	expect(preset).toBeDefined();
	expect(preset?.pools?.["core.plan"]).toEqual([
		{ label: "quick", profile: "b", default: true },
	]);
	t.renderer.destroy();
});

test("stored model pools survive an unchanged preset save", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "opencode" } },
				presets: {
					classified: {
						default_profile: "a",
						pools: {
							"core.plan": [
								{
									label: "quick",
									profile: "b",
									criteria: { what: "small" },
									default: true,
								},
								{ label: "thorough", profile: "a" },
							],
						},
					},
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	t.mockInput.pressEnter(); // open the prefilled preset form
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	t.mockInput.pressEnter(); // save unchanged preset from Preset name
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	const preset = (
		wroteConfig().agents as {
			presets: Record<string, { pools?: Record<string, unknown[]> }>;
		}
	).presets.classified;
	expect(preset?.pools?.["core.plan"]).toEqual([
		{
			label: "quick",
			profile: "b",
			criteria: { what: "small" },
			default: true,
		},
		{ label: "thorough", profile: "a" },
	]);
	t.renderer.destroy();
});

test("pool entries copy between steps and paste as ordered config", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "opencode" } },
				presets: {
					classified: {
						pools: {
							"core.plan": [
								{
									label: "quick",
									profile: "a",
									criteria: { complexity: "small" },
									default: true,
								},
								{ label: "steady", profile: "b" },
							],
						},
					},
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	t.mockInput.pressTab();
	t.mockInput.pressTab(); // focus core.plan on full step list
	await t.renderOnce();
	const actions = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.action),
	);
	expect(actions).toContain("copy pool");
	expect(actions).toContain("paste pool");
	t.mockInput.pressKey("y");
	expect(activeNotification()?.message).toContain(
		"Copied pool entries from core.plan",
	);
	t.mockInput.pressTab(); // fusion.consolidate on same list
	await t.renderOnce();
	t.mockInput.pressKey("p");
	expect(await renderUntil(t, (frame) => frame.includes("2 entries"))).toBe(
		true,
	);
	for (let index = 0; index < 3; index += 1) {
		t.mockInput.pressKey("k");
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	expect(
		await renderUntil(t, () =>
			Boolean(
				(
					wroteConfig().agents as {
						presets: Record<string, { pools?: Record<string, unknown[]> }>;
					}
				).presets.classified?.pools?.["fusion.consolidate"],
			),
		),
	).toBe(true);
	const pools = (
		wroteConfig().agents as {
			presets: Record<string, { pools?: Record<string, unknown[]> }>;
		}
	).presets.classified?.pools;
	expect(pools?.["fusion.consolidate"]).toEqual([
		{
			label: "quick",
			profile: "a",
			criteria: { complexity: "small" },
			default: true,
		},
		{ label: "steady", profile: "b" },
	]);
	t.renderer.destroy();
});

test("a profile referenced only by a pool entry cannot be deleted", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" } },
				presets: {
					classified: {
						pools: {
							"core.plan": [{ label: "quick", profile: "a", default: true }],
						},
					},
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter(); // Model profiles list
	expect(await renderUntil(t, (frame) => frame.includes("a"))).toBe(true);
	t.mockInput.pressKey("d");
	expect(
		await renderUntil(t, (frame) => frame.includes("Delete profile?")),
	).toBe(true);
	t.mockInput.pressKey("y");
	await t.renderOnce();
	expect(activeNotification()?.message).toContain(
		"presets.classified.pools.core.plan.quick",
	);
	expect(
		(wroteConfig().agents as { profiles: Record<string, unknown> }).profiles,
	).toHaveProperty("a");
	t.renderer.destroy();
});

test("the preset form exposes an entry manager per classifiable step", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: { profiles: { a: { runtime: "pi" } } },
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => frame.includes("use-default-model"));
	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	// Walk every field and collect the pool rows that scroll past.
	const expected = POOL_EDITOR_STEPS.map(
		({ stepId }) => `Pool ${stepId} entries`,
	);
	const seen = new Set<string>();
	for (let index = 0; index < 80; index += 1) {
		const frame = t.captureCharFrame();
		for (const label of expected) if (frame.includes(label)) seen.add(label);
		t.mockInput.pressTab();
		await t.renderOnce();
	}
	for (const label of expected) expect(seen.has(label)).toBe(true);
	t.renderer.destroy();
});

test("existing pool entries open label and roster-default subforms", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "pi" } },
				presets: {
					classified: {
						pools: {
							"core.plan": [{ label: "quick", profile: "a", default: true }],
							"fusion.plan": [
								{ label: "strong", profile: "a", default: true },
								{ label: "fast", profile: "b", default: true },
							],
						},
					},
				},
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	for (let index = 0; index < 4; index += 1) {
		t.mockInput.pressTab();
		await t.renderOnce();
	}
	expect(
		await renderUntil(t, (frame) => frame.includes("Pool fusion.plan entries")),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("strong"))).toBe(true);
	const poolKeys = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.key),
	);
	expect(poolKeys).toContain("Shift+↑/↓");
	t.mockInput.pressArrow("down", { shift: true });
	await t.renderOnce();
	const movedFrame = t.captureCharFrame();
	expect(movedFrame.indexOf("fast")).toBeLessThan(movedFrame.indexOf("strong"));
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Profile tag"))).toBe(
		true,
	);
	let frame = t.captureCharFrame();
	expect(frame).toContain("Profile tag");
	expect(frame).toContain("Agent profile");
	expect(frame).toContain("Roster default");
	t.mockInput.pressTab();
	await t.renderOnce();
	t.mockInput.pressTab();
	expect(await renderUntil(t, (value) => value.includes("● default"))).toBe(
		true,
	);
	frame = t.captureCharFrame();
	expect(frame).toContain("● default");
	t.renderer.destroy();
});

test("text fields accept quote characters", async () => {
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => frame.includes("No model profiles"));
	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	await editText(t, `o'k"`);
	await t.renderOnce();
	saveWithEnter(t);
	const name = `o'k"`;
	expect(await renderUntil(t, (frame) => frame.includes(name))).toBe(true);
	const profiles = (
		wroteConfig().agents as { profiles: Record<string, unknown> }
	).profiles;
	expect(profiles).toHaveProperty(name);
	t.renderer.destroy();
});

test("read-only rows are dropped and an editable row still activates", async () => {
	const activated: string[] = [];
	const items: SettingsItem[] = [
		{
			id: "agents.scope",
			label: "Scope",
			value: "user configuration",
			detail: "this client · next workflow start",
			editable: false,
			action: { kind: "none" },
		},
		{
			id: "agents.routing.Default profile",
			label: "Default profile",
			value: "(unset)",
			detail: "read-only: edit the config file",
			editable: false,
			action: { kind: "none" },
		},
		{
			id: "agents.profiles",
			label: "Model profiles",
			value: "0 configured",
			detail: "d",
			editable: true,
			action: { kind: "none" },
		},
		{
			id: "agents.presets",
			label: "Presets",
			value: "0 configured",
			detail: "d",
			editable: true,
			action: { kind: "none" },
		},
		{
			id: "agents.reset-scope",
			label: "Reset to user scope",
			value: "",
			detail: "leaves the project configuration untouched",
			editable: true,
			action: { kind: "navigate", route: { page: "settings.agents" } },
		},
	];
	const t = await renderView({
		items,
		onActivate: (item) => activated.push(item.id),
	});
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	const frame = t.captureCharFrame();
	// Read-only settings are not actionable here, so they are not listed.
	expect(frame).not.toContain("Scope");
	expect(frame).not.toContain("Default profile");
	expect(frame).toContain("Reset to user scope");
	// rows: 0 Model profiles, 1 Presets, 2 Reset to user scope.
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	expect(activated).toContain("agents.reset-scope");
	t.renderer.destroy();
});

test("deleting the last entry re-clamps the cursor onto the remaining row", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "pi" } },
			},
		})}\n`,
	);
	clearAgentConfigCache();
	const t = await renderView();
	expect(
		await renderUntil(t, (frame) => frame.includes("Model profiles")),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("b"))).toBe(true);
	t.mockInput.pressKey("j"); // cursor on the second (last) entry
	await t.renderOnce();
	t.mockInput.pressKey("d");
	await renderUntil(t, (frame) => frame.includes("Delete profile?"));
	t.mockInput.pressKey("y");
	// The list now holds only "a"; the cursor must re-clamp so Enter opens it
	// instead of pointing past the end.
	expect(
		await renderUntil(
			t,
			(frame) => frame.includes("a") && !frame.includes("Delete profile?"),
		),
	).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("Profile name"))).toBe(
		true,
	);
	t.renderer.destroy();
});

test("the menu cursor re-clamps when the inventoried rows shrink", async () => {
	const option = (id: string, label: string): SettingsItem => ({
		id,
		label,
		value: "",
		detail: "d",
		editable: true,
		action: { kind: "none" },
	});
	const longItems = [
		option("agents.profiles", "Model profiles"),
		option("agents.presets", "Presets"),
		option("agents.repository", "Project checkout"),
		option("agents.reset-scope", "Reset to user scope"),
	];
	const shortItems = [
		option("agents.profiles", "Model profiles"),
		option("agents.presets", "Presets"),
	];
	const [items, setItems] = createSignal<SettingsItem[]>(longItems);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return <AgentPresetsView keymap={keymap} items={items()} />;
		},
		{ width: 110, height: 30 },
	);
	await t.flush();
	await t.renderOnce();
	expect(
		await renderUntil(t, (frame) => frame.includes("Reset to user scope")),
	).toBe(true);
	// Cursor on the last row, then the inventoried rows disappear under it.
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	setItems(shortItems);
	await t.renderOnce();
	// The cursor must have re-clamped onto "Presets", so Enter opens its list.
	t.mockInput.pressEnter();
	expect(
		await renderUntil(t, (frame) => frame.includes("use-default-model")),
	).toBe(true);
	t.renderer.destroy();
});
