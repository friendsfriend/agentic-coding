/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { uiColors } from "@agentic-coding/ui";
import {
	BoxRenderable,
	parseColor,
	type Renderable,
	TextRenderable,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import type { ClassifierStatusResponse } from "../../src/contracts/gateway.ts";
import {
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import { clearAgentConfigCache } from "../../src/tui/dash/agent-config-cache.ts";
import { clearClassifierSnapshot } from "../../src/tui/dash/classifier-status.ts";
import {
	AgentPresetsView,
	type AgentPresetsViewProps,
} from "../../src/tui/settings/AgentPresetsView.tsx";
import type { SettingsItem } from "../../src/tui/settings/items.ts";

const classifier: ClassifierStatusResponse = {
	provider: "opencode-zen",
	providers: [
		{ id: "opencode-zen", label: "Hosted choice" },
		{ id: "laya-local", label: "Offline choice" },
	],
	local: { installed: true, running: true },
};

beforeEach(() => {
	const client = configureBackendClient({
		baseUrl: "http://unused.invalid",
		token: "test",
		ownerId: "settings-identity-test",
	});
	spyOn(client, "loadAgents").mockResolvedValue({
		agents: {
			profiles: {
				fast: { runtime: "pi", model: "model-a" },
				slow: { runtime: "pi", model: "model-b" },
			},
			presets: {},
		},
		provenance: {},
		conflicts: [],
	});
	spyOn(client, "classifierStatus").mockResolvedValue(classifier);
	clearAgentConfigCache();
	clearClassifierSnapshot();
});

afterEach(() => {
	clearAgentConfigCache();
	clearClassifierSnapshot();
	clearBackendClient();
});

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

function Fixture(props: AgentPresetsViewProps) {
	const keymap = createDefaultOpenTuiKeymap(useRenderer());
	const dispose = keymap.registerLayerFields({ name: () => undefined });
	onCleanup(dispose);
	return <AgentPresetsView {...props} keymap={keymap} />;
}

type TestView = Awaited<ReturnType<typeof testRender>>;
function point(t: TestView, label: string) {
	const lines = t.captureCharFrame().split("\n");
	const y = lines.findIndex((line) => line.includes(label));
	if (y < 0) throw new Error(`Missing settings row: ${label}`);
	return { x: (lines[y] ?? "").indexOf(label) + 2, y };
}

const item = (id: string, label: string): SettingsItem => ({
	id,
	label,
	value: "one",
	detail: "Original information",
	editable: true,
	action: { kind: "none" },
});

test("Agent Presets menu retains cards and follows the same informational item across refreshed order", async () => {
	const [items, setItems] = createSignal([
		item("info-a", "Info Alpha"),
		item("info-b", "Info Beta"),
	]);
	const activated: SettingsItem[] = [];
	const t = await testRender(
		() => (
			<Fixture items={items()} onActivate={(item) => activated.push(item)} />
		),
		{ width: 120, height: 30 },
	);
	try {
		await t.flush();
		const location = point(t, "Info Alpha");
		await t.mockMouse.moveTo(location.x, location.y);
		await t.flush();
		const card = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 3 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		if (!(card instanceof BoxRenderable))
			throw new Error("Missing informational card");
		await t.mockMouse.click(location.x, location.y);
		await t.flush();
		setItems((current) =>
			[...current].reverse().map((entry) => ({
				...entry,
				...(entry.id === "info-a"
					? { value: "two", detail: "Updated information" }
					: {}),
			})),
		);
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Updated information");
		t.mockInput.pressEnter();
		await t.flush();
		expect(activated).toHaveLength(1);
		expect(activated[0]?.id).toBe("info-a");
		expect(activated[0]?.value).toBe("two");
	} finally {
		t.renderer.destroy();
	}
});

test("classifier provider cards retain hover and current metadata while catalog order changes", async () => {
	const [status, setStatus] = createSignal(classifier);
	const t = await testRender(
		() => (
			<Fixture
				items={[item("agents.classifier", "Classifier")]}
				classifier={status()}
			/>
		),
		{ width: 120, height: 30 },
	);
	try {
		await t.flush();
		const location = point(t, "Classifier");
		await t.mockMouse.click(location.x, location.y);
		await t.flush();
		await t.mockMouse.click(location.x, location.y);
		await t.flush();
		const offline = point(t, "Offline choice");
		await t.mockMouse.moveTo(offline.x, offline.y);
		await t.flush();
		const card = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 3 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		const label = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable &&
				node.plainText.includes("Offline choice"),
		);
		if (!(card instanceof BoxRenderable) || !(label instanceof TextRenderable))
			throw new Error("Missing classifier provider card");
		setStatus((current) => ({
			...current,
			local: { installed: true, running: false },
			providers: current.providers.map((provider) => ({
				...provider,
				...(provider.id === "laya-local" ? { label: "Offline updated" } : {}),
			})),
		}));
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(label.isDestroyed).toBe(false);
		expect(label.plainText).toContain("Offline updated");
		expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(t.captureCharFrame()).toContain("installed (not running)");
		setStatus((current) => ({
			...current,
			providers: [...current.providers].reverse(),
		}));
		await t.flush();
		await t.mockMouse.moveTo(119, 29);
		await t.flush();
		expect(card.isDestroyed).toBe(false);
		// Theme surfaces can share colors; assert the actual selection marker,
		// not an assumption that the selection fill uniquely identifies a card.
		const selected = t
			.captureCharFrame()
			.split("\n")
			.find((line) => line.includes("Hosted choice"));
		expect(selected).toMatch(/^\s*│.*Hosted choice/);
	} finally {
		t.renderer.destroy();
	}
});

test("profile cards stay mounted when the keyboard cursor moves", async () => {
	const t = await testRender(() => <Fixture />, { width: 120, height: 30 });
	try {
		await t.flush();
		t.mockInput.pressEnter();
		await t.flush();
		const location = point(t, "slow");
		await t.mockMouse.moveTo(location.x, location.y);
		await t.flush();
		const card = tree(t.renderer.root)
			.filter(
				(node) =>
					node instanceof BoxRenderable &&
					node.height === 3 &&
					node.backgroundColor.equals(parseColor(uiColors.bgHover)),
			)
			.at(-1);
		if (!(card instanceof BoxRenderable))
			throw new Error("Missing profile card");
		t.mockInput.pressKey("j");
		await t.renderOnce();
		expect(card.isDestroyed).toBe(false);
		expect(card.backgroundColor).toEqual(parseColor(uiColors.bgHover));
		expect(t.captureCharFrame()).toContain("model-b");
	} finally {
		t.renderer.destroy();
	}
});
