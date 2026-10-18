// The Compaction Settings section and its bounded numeric editor
// (add-agent-compaction, tasks 4.1–4.3).
//
// The pure halves only: what each row states for defaults/configured/overridden
// values, and what the editor accepts, rejects and resolves. The shell that
// renders them is covered by the Settings page/browser tests.
import { describe, expect, test } from "bun:test";
import {
	inventoryEntry,
	inventoryGaps,
	SETTINGS_INVENTORY,
} from "../src/tui/settings/catalog.ts";
import {
	type CompactionSettingsSnapshot,
	compactionSourceLabel,
	compactionTokenValueLabel,
	type SettingsContext,
	settingsItems,
} from "../src/tui/settings/items.ts";
import {
	acceptEditorKeystroke,
	compactionEditorField,
	readEditorDraft,
} from "../src/tui/settings/NumberEditor.tsx";
import { settingsSectionOfPage } from "../src/tui/shared/routes.ts";
import {
	COMPACTION_CEILING_DEFAULT,
	COMPACTION_CEILING_MINIMUM,
	COMPACTION_PERCENT_MAX,
	COMPACTION_TOKEN_CEILING,
	COMPACTION_TOKEN_FLOOR,
} from "../src/workflow/compaction.ts";

const DEFAULTS = {
	enabled: true,
	reserveTokens: 32000,
	backgroundTokens: 32000,
	keepRecentTokens: 20000,
};

const CEILING = {
	ceilingTokens: COMPACTION_CEILING_DEFAULT,
	active: true,
	floorTurns: 20,
	floorTokens: 40000,
	loopTurns: 10,
	loopLimit: 3,
};

function snapshot(
	overrides: Partial<CompactionSettingsSnapshot> = {},
): CompactionSettingsSnapshot {
	return {
		configured: {},
		configuredIsDefault: true,
		effective: DEFAULTS,
		ceiling: CEILING,
		source: "default",
		validation: [],
		defaults: DEFAULTS,
		...overrides,
	};
}

function context(
	compaction: CompactionSettingsSnapshot | undefined,
): SettingsContext {
	return {
		themes: ["catppuccin"],
		activeTheme: "catppuccin",
		clientSettingsPath: "/tmp/tui.json",
		section: "compaction",
		agents: {
			scope: "user",
			files: [],
			conflicts: [],
			profiles: [],
			presets: [],
			routing: [],
			...(compaction ? { compaction } : {}),
		},
		providers: { state: "ready", providers: [] },
	};
}

describe("compaction settings inventory", () => {
	test("the section is inventoried, rendered and gap-free", () => {
		expect(settingsSectionOfPage("settings.compaction")).toBe("compaction");
		expect(inventoryGaps()).toEqual([]);
		const entry = inventoryEntry("agents.compaction");
		expect(entry?.section).toBe("compaction");
		expect(entry?.scope).toBe("user");
		expect(entry?.effect).toBe("immediate");
		expect(entry?.editable).toBe(true);
		expect(entry?.storage).toContain("[agents.compaction]");
	});

	test("every inventoried item of the section reaches a rendered row", () => {
		const ids = settingsItems(context(snapshot())).map((item) => item.id);
		for (const prefix of inventoryEntry("agents.compaction")?.items ?? [])
			expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
	});
});

describe("compaction section rows", () => {
	test("the documented defaults are shown, marked as defaults", () => {
		const items = settingsItems(context(snapshot()));
		const reserve = items.find(
			(item) => item.id === "compaction.reserveTokens",
		);
		expect(reserve?.value).toBe("32000 tokens (default)");
		expect(reserve?.detail).toContain("documented defaults");
		expect(items.find((item) => item.id === "compaction.enabled")?.value).toBe(
			"on",
		);
		expect(
			items.find((item) => item.id === "compaction.backgroundTokens")?.value,
		).toBe("32000 tokens (default)");
		expect(
			items.find((item) => item.id === "compaction.keepRecentTokens")?.value,
		).toBe("20000 tokens (default)");
		// The reference window is per run, so the row states the rule.
		expect(
			items.find((item) => item.id === "compaction.reference-window")?.value,
		).toContain("smallest model window");
	});

	test("a configured value shows the effective one and its source", () => {
		const items = settingsItems(
			context(
				snapshot({
					configured: { reserveTokens: 45000 },
					configuredIsDefault: false,
					source: "agents",
					effective: { ...DEFAULTS, reserveTokens: 45000 },
				}),
			),
		);
		const reserve = items.find(
			(item) => item.id === "compaction.reserveTokens",
		);
		expect(reserve?.value).toBe("45000 tokens");
		expect(reserve?.detail).toContain("[agents.compaction]");
		expect(reserve?.editable).toBe(true);
		expect(reserve?.action).toEqual({
			kind: "numeric-edit",
			field: "reserveTokens",
		});
	});

	test("a percentage names its per-run resolution and the fallback value", () => {
		const items = settingsItems(
			context(
				snapshot({
					configured: { keepRecentTokens: "15%" },
					configuredIsDefault: false,
					source: "agents",
					effective: { ...DEFAULTS, keepRecentTokens: 20000 },
				}),
			),
		);
		const row = items.find((item) => item.id === "compaction.keepRecentTokens");
		expect(row?.value).toBe("15% → 20000 tokens without a known window");
		expect(row?.detail).toContain("smallest context window");
	});

	test("the agentHost override is named as the source, and a known window is shown", () => {
		expect(compactionSourceLabel("agentHost")).toContain("override");
		const items = settingsItems(
			context(snapshot({ source: "agentHost", referenceWindow: 128000 })),
		);
		expect(
			items.find((item) => item.id === "compaction.reserveTokens")?.detail,
		).toContain("agentHost.compaction override");
		expect(
			items.find((item) => item.id === "compaction.reference-window")?.value,
		).toBe("128000 tokens");
	});

	test("the cost ceiling row states the default, the ignored case and the off case", () => {
		const items = settingsItems(context(snapshot()));
		const row = items.find((item) => item.id === "compaction.ceilingTokens");
		expect(row?.label).toBe("Cost ceiling");
		expect(row?.value).toBe("150000 tokens (default)");
		expect(row?.action).toEqual({
			kind: "numeric-edit",
			field: "ceilingTokens",
		});
		expect(row?.detail).toContain("overflow threshold");
		// A small window leaves the overflow guard tighter, so the row says the
		// ceiling is ignored and names the threshold it lost against.
		const ignored = settingsItems(
			context(
				snapshot({
					ceiling: {
						...CEILING,
						active: false,
						inactive: "above-overflow",
						overflowTokens: 68000,
					},
				}),
			),
		).find((item) => item.id === "compaction.ceilingTokens");
		expect(ignored?.value).toContain("ignored");
		expect(ignored?.value).toContain("68000");
		// A configured 0 is shown as the off switch, not as a default.
		const off = settingsItems(
			context(
				snapshot({
					configured: { ceilingTokens: 0 },
					configuredIsDefault: false,
					source: "agents",
					ceiling: {
						...CEILING,
						ceilingTokens: 0,
						active: false,
						inactive: "off",
					},
				}),
			),
		).find((item) => item.id === "compaction.ceilingTokens");
		expect(off?.value).toBe("0 tokens");
	});

	test("the editor edits the cost ceiling as an absolute value only", () => {
		const field = compactionEditorField("ceilingTokens");
		expect(field.min).toBe(0);
		expect(field.percent).toBe(false);
		expect(field.label).toBe("Cost ceiling");
		expect(readEditorDraft("ceilingTokens", "90000")).toEqual({
			ok: true,
			value: 90000,
		});
		expect(readEditorDraft("ceilingTokens", "0")).toEqual({
			ok: true,
			value: 0,
		});
		const percent = readEditorDraft("ceilingTokens", "15%");
		expect(percent.ok).toBe(false);
		if (!percent.ok) expect(percent.message).toContain("absolute");
		const tiny = readEditorDraft("ceilingTokens", "10000");
		expect(tiny.ok).toBe(false);
		if (!tiny.ok)
			expect(tiny.message).toContain(String(COMPACTION_CEILING_MINIMUM));
		// The window-relative fields keep their percentage form.
		expect(compactionEditorField("keepRecentTokens").percent).toBe(true);
	});

	test("a rejected value is surfaced as its own row", () => {
		const items = settingsItems(
			context(
				snapshot({
					validation: [
						{ field: "keepRecentTokens", message: "keepRecentTokens: wat" },
					],
				}),
			),
		);
		const error = items.find(
			(item) => item.id === "compaction.error.keepRecentTokens",
		);
		expect(error?.value).toContain("keepRecentTokens: wat");
		expect(error?.editable).toBe(false);
	});

	test("an unresolved read is a retryable row instead of a silent default", () => {
		const items = settingsItems(context(undefined));
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("compaction.unavailable");
		expect(items[0]?.action).toEqual({ kind: "retry" });
	});

	test("a `0` background value is shown as the disabled path, not as a default", () => {
		expect(compactionTokenValueLabel(0, 0)).toBe("0 tokens");
		const items = settingsItems(
			context(
				snapshot({
					configured: { backgroundTokens: 0 },
					configuredIsDefault: false,
					source: "agents",
					effective: { ...DEFAULTS, backgroundTokens: 0 },
				}),
			),
		);
		expect(
			items.find((item) => item.id === "compaction.backgroundTokens")?.value,
		).toBe("0 tokens");
	});
});

describe("the bounded numeric editor", () => {
	test("only what can be part of a valid value is accepted", () => {
		expect(acceptEditorKeystroke("", "4")).toBe("4");
		expect(acceptEditorKeystroke("45", "0")).toBe("450");
		expect(acceptEditorKeystroke("45", "%")).toBe("45%");
		// A second `%`, a letter, a space and a decimal point are all refused.
		expect(acceptEditorKeystroke("45%", "%")).toBe("45%");
		expect(acceptEditorKeystroke("45", "x")).toBe("45");
		expect(acceptEditorKeystroke("45", " ")).toBe("45");
		expect(acceptEditorKeystroke("45", ".")).toBe("45");
		// Typing after a `%` replaces it rather than making the draft invalid.
		expect(acceptEditorKeystroke("45%", "6")).toBe("456");
	});

	test("a whole count within the field's bounds is accepted", () => {
		expect(readEditorDraft("reserveTokens", "45000")).toEqual({
			ok: true,
			value: 45000,
		});
		expect(readEditorDraft("backgroundTokens", "0")).toEqual({
			ok: true,
			value: 0,
		});
	});

	test("a below-floor, absurd or malformed entry is refused with a message", () => {
		const tooSmall = readEditorDraft("reserveTokens", "10");
		expect(tooSmall.ok).toBe(false);
		if (!tooSmall.ok) expect(tooSmall.message).toContain("reserveTokens");
		expect(
			readEditorDraft("keepRecentTokens", String(COMPACTION_TOKEN_CEILING + 1))
				.ok,
		).toBe(false);
		expect(readEditorDraft("keepRecentTokens", "nonsense").ok).toBe(false);
		expect(readEditorDraft("keepRecentTokens", "").ok).toBe(false);
		// `backgroundTokens` is the one field that accepts 0 …
		expect(readEditorDraft("backgroundTokens", "-1").ok).toBe(false);
	});

	test("the percentage form is bounded", () => {
		expect(readEditorDraft("keepRecentTokens", "15%")).toEqual({
			ok: true,
			value: "15%",
		});
		const tooBig = readEditorDraft(
			"keepRecentTokens",
			`${COMPACTION_PERCENT_MAX + 1}%`,
		);
		expect(tooBig.ok).toBe(false);
		if (!tooBig.ok) expect(tooBig.message).toContain("percentage");
		expect(readEditorDraft("keepRecentTokens", "0%").ok).toBe(false);
	});

	test("the editor's bounds come from the shared field rules", () => {
		expect(compactionEditorField("reserveTokens").min).toBe(
			COMPACTION_TOKEN_FLOOR,
		);
		expect(compactionEditorField("backgroundTokens").min).toBe(0);
		expect(compactionEditorField("keepRecentTokens").max).toBe(
			COMPACTION_TOKEN_CEILING,
		);
		expect(compactionEditorField("keepRecentTokens").label).toBe(
			"Kept verbatim",
		);
	});

	test("the inventory owns exactly one editable compaction entry", () => {
		expect(
			SETTINGS_INVENTORY.filter((entry) => entry.section === "compaction"),
		).toHaveLength(1);
	});
});
