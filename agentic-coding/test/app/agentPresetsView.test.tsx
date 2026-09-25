/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { activeKeybindCatalog } from "@ui";
import { createSignal, onCleanup } from "solid-js";
import { clearAgentConfigCache } from "../../src/tui/dash/agent-config-cache.ts";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/dash/notifications.ts";
import { AgentPresetsView } from "../../src/tui/settings/AgentPresetsView.tsx";
import { FUSION_PLAN_ROLES } from "../../src/tui/settings/agentPresets.ts";
import type { SettingsItem } from "../../src/tui/settings/items.ts";
import { VERIFIER_ROLES } from "../../src/workflow/steps/verification.ts";
import { renderUntil } from "./support/terminal.ts";

// The inline Agent Presets surface (rework-model-profiles-and-presets). Rendered
// checks: the menu, the list, `+` creating a blank form, validation errors,
// prefilled editing, reference-safe deletion and preset role coverage. Keys go
// through the real keymap layer the component registers, so the surface is
// exercised the way a terminal drives it.

let configDir: string;
let configFile: string;
const previousEnv = process.env.HERDR_WORKFLOW_CONFIG;

beforeEach(() => {
	resetNotifications();
	clearAgentConfigCache();
	configDir = mkdtempSync(join(tmpdir(), "agent-presets-view-"));
	configFile = join(configDir, "config.json");
	writeFileSync(configFile, "{}\n");
	process.env.HERDR_WORKFLOW_CONFIG = configFile;
});

afterEach(() => {
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
	const formActions = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.key),
	);
	expect(formActions).toContain("Enter");
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

	// Type the name, then save with Enter on the last field.
	for (const char of "fresh") t.mockInput.pressKey(char);
	await t.renderOnce();
	saveWithEnter(t);
	expect(await renderUntil(t, (frame) => frame.includes("fresh"))).toBe(true);
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
	for (let index = 0; index < "old".length; index += 1)
		t.mockInput.pressBackspace();
	for (const char of "new") t.mockInput.pressKey(char);
	await t.renderOnce();
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
	for (let index = 0; index < "used".length; index += 1)
		t.mockInput.pressBackspace();
	for (const char of "renamed") t.mockInput.pressKey(char);
	await t.renderOnce();
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

test("presets list exposes the built-in and creates a preset with a step route", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: { profiles: { a: { runtime: "pi" }, b: { runtime: "pi" } } },
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
	for (const char of "my-preset") t.mockInput.pressKey(char);
	// name → default profile → four complexity fields → step core.plan.
	for (let index = 0; index < 6; index += 1) t.mockInput.pressTab();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Step core.plan");
	t.mockInput.pressKey("l"); // choose profile "a"
	await t.renderOnce();
	saveWithEnter(t);
	expect(await renderUntil(t, (frame) => frame.includes("my-preset"))).toBe(
		true,
	);
	const preset = (
		wroteConfig().agents as {
			presets: Record<string, { steps?: Record<string, string> }>;
		}
	).presets["my-preset"];
	expect(preset).toBeDefined();
	expect(preset?.steps).toEqual({ "core.plan": "a" });
	t.renderer.destroy();
});

test("the preset form assigns a profile to a complexity category", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "opencode" } },
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
	await renderUntil(t, (frame) => frame.includes("use-default-model"));
	t.mockInput.pressKey("+");
	expect(await renderUntil(t, (frame) => frame.includes("Preset name"))).toBe(
		true,
	);
	for (const char of "classified") t.mockInput.pressKey(char);
	t.mockInput.pressTab(); // default profile
	t.mockInput.pressTab(); // complexity easy
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Complexity easy");
	t.mockInput.pressKey("l"); // choose the saved profile "a"
	await t.renderOnce();
	t.mockInput.pressKey("s", { ctrl: true });
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	const preset = (
		wroteConfig().agents as {
			presets: Record<string, { easy?: string }>;
		}
	).presets.classified;
	expect(preset?.easy).toBe("a");
	t.renderer.destroy();
});

test("stored complexity mappings survive an unchanged preset save", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" }, b: { runtime: "opencode" } },
				presets: {
					classified: { default_profile: "a", easy: "b", critical: "a" },
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
	t.mockInput.pressKey("s", { ctrl: true });
	expect(await renderUntil(t, (frame) => frame.includes("classified"))).toBe(
		true,
	);
	const preset = (
		wroteConfig().agents as {
			presets: Record<string, { easy?: string; critical?: string }>;
		}
	).presets.classified;
	expect(preset?.easy).toBe("b");
	expect(preset?.critical).toBe("a");
	t.renderer.destroy();
});

test("a profile referenced only by a complexity mapping cannot be deleted", async () => {
	writeFileSync(
		configFile,
		`${JSON.stringify({
			agents: {
				profiles: { a: { runtime: "pi" } },
				presets: { classified: { easy: "a" } },
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
	expect(activeNotification()?.message).toContain("presets.classified.easy");
	expect(
		(wroteConfig().agents as { profiles: Record<string, unknown> }).profiles,
	).toHaveProperty("a");
	t.renderer.destroy();
});

test("the preset form renders every registered verification role and fusion planner", async () => {
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
	// Walk every field and collect the role rows that scroll past.
	const expected = [
		...FUSION_PLAN_ROLES.map((role) => `Fusion ${role}`),
		...VERIFIER_ROLES.map((role) => `Verification ${role}`),
	];
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

test("the preset form renders every complexity assignment field", async () => {
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
	const expected = [
		"Complexity easy",
		"Complexity medium",
		"Complexity hard",
		"Complexity critical",
	];
	const seen = new Set<string>();
	for (let index = 0; index < 12; index += 1) {
		const frame = t.captureCharFrame();
		for (const label of expected) if (frame.includes(label)) seen.add(label);
		t.mockInput.pressTab();
		await t.renderOnce();
	}
	for (const label of expected) expect(seen.has(label)).toBe(true);
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
	for (const char of ["o", "'", "k", '"']) t.mockInput.pressKey(char);
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
