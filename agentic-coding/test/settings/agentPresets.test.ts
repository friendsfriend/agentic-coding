import { describe, expect, test } from "bun:test";
import {
	applyDraftValue,
	type PresetDraft,
	poolDefaultKey,
	poolLabelsKey,
	poolProfileKey,
	presetDraft,
	presetFields,
	presetMutation,
	profileDraft,
	profileMutation,
	profileReferences,
	splitPoolLabels,
	validateDraft,
} from "../../src/tui/settings/agentPresets.ts";
import type { AgentsConfig } from "../../src/workflow/profiles.ts";

const agents: AgentsConfig = {
	default_profile: "used",
	profiles: {
		used: { runtime: "pi", model: "vendor/model", thinking: "high" },
		free: { runtime: "opencode" },
	},
	routes: { "core.plan": "used" },
	role_routes: { "core.implementation": { worker: "used" } },
	definition_defaults: { openspec: "used" },
	presets: {
		routed: {
			default_profile: "used",
			steps: { "core.plan": "used" },
			roles: { "custom.step": { "custom-role": "used" } },
			pools: {
				"core.plan": [
					{ label: "quick", profile: "used", criteria: { what: "small" } },
					{ label: "thorough", profile: "free", default: true },
				],
				"fusion.plan": [
					{ label: "strong", profile: "used", default: true },
					{ label: "balanced", profile: "free", default: true },
				],
			},
		},
	},
};

describe("agent preset drafts", () => {
	test("a prefilled profile draft carries the stored values", () => {
		const draft = profileDraft("used", agents.profiles.used);
		expect(draft).toMatchObject({
			kind: "profile",
			name: "used",
			originalName: "used",
			runtime: "pi",
			model: "vendor/model",
			thinking: "high",
		});
	});

	test("changing a runtime clears the runtime-specific fields", () => {
		const draft = profileDraft("used", agents.profiles.used);
		const next = applyDraftValue(draft, "runtime", "opencode");
		expect(next).toMatchObject({
			runtime: "opencode",
			model: "",
			thinking: "",
		});
	});

	test("a preset draft loads stored pools into labels, profiles, and defaults", () => {
		const draft = presetDraft("routed", agents.presets);
		expect(draft.poolLabels["core.plan"]).toBe("quick, thorough");
		expect(draft.poolProfiles["core.plan\u0000quick"]).toBe("used");
		expect(draft.poolProfiles["core.plan\u0000thorough"]).toBe("free");
		expect(draft.poolDefaults["core.plan\u0000thorough"]).toBe(true);
		// Step/role assignments outside the pool fields survive.
		expect(draft.steps).toEqual({ "core.plan": "used" });
		expect(draft.roles).toEqual({ "custom.step": { "custom-role": "used" } });
	});

	test("the expanded preset form derives one select per label", () => {
		const draft = presetDraft("routed", agents.presets);
		const keys = presetFields(draft, ["used", "free"]).map((f) => f.key);
		expect(keys).toContain(poolLabelsKey("core.plan"));
		expect(keys).toContain(poolProfileKey("core.plan", "quick"));
		expect(keys).toContain(poolProfileKey("core.plan", "thorough"));
		// Only the fusion roster exposes default toggles.
		expect(keys).toContain(poolDefaultKey("fusion.plan", "strong"));
		expect(keys).not.toContain(poolDefaultKey("core.plan", "quick"));
	});

	test("editing the label text derives the matching profile selects", () => {
		const draft = presetDraft("new", {});
		const next = applyDraftValue(
			draft,
			poolLabelsKey("core.plan"),
			"alpha, beta",
		) as PresetDraft;
		const keys = presetFields(next, ["used", "free"]).map((f) => f.key);
		expect(keys).toContain(poolProfileKey("core.plan", "alpha"));
		expect(keys).toContain(poolProfileKey("core.plan", "beta"));
		expect(splitPoolLabels(next.poolLabels["core.plan"] ?? "")).toEqual([
			"alpha",
			"beta",
		]);
	});

	test("a label edit drops the removed entry on save", () => {
		const draft = presetDraft("routed", agents.presets);
		const next = applyDraftValue(
			draft,
			poolLabelsKey("core.plan"),
			"quick",
		) as PresetDraft;
		const mutation = presetMutation(next);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.pools?.["core.plan"]?.map((e) => e.label)).toEqual([
			"quick",
		]);
	});
});

describe("agent preset validation", () => {
	test("a blank name is refused in place", () => {
		expect(validateDraft(profileDraft("", undefined), [])).toEqual({
			name: "Name is required",
		});
	});

	test("the reserved built-in name is refused", () => {
		expect(
			validateDraft(presetDraft("use-default-model", agents.presets), []),
		).toMatchObject({
			name: '"use-default-model" is reserved',
		});
	});

	test("a custom preset without pools is refused", () => {
		const draft = presetDraft("empty", {});
		expect(validateDraft(draft, [])).toMatchObject({
			name: "A preset must declare at least one model pool",
		});
	});

	test("fusion default counts outside 2-5 are refused", () => {
		const draft = presetDraft("routed", agents.presets);
		const one = applyDraftValue(
			draft,
			poolDefaultKey("fusion.plan", "balanced"),
			"",
		) as PresetDraft;
		expect(validateDraft(one, [])).toMatchObject({
			[poolLabelsKey("fusion.plan")]:
				"fusion.plan needs 2-5 entries marked default",
		});
	});
});

describe("agent preset mutations", () => {
	test("a profile mutation trims the name and omits empty optional fields", () => {
		const draft = profileDraft("", undefined);
		const next = applyDraftValue(
			applyDraftValue(draft, "name", "  trimmed  "),
			"runtime",
			"opencode",
		) as PresetDraft & { kind: "profile" };
		expect(profileMutation(next)).toEqual({
			kind: "set-profile",
			name: "trimmed",
			profile: { runtime: "opencode" },
		});
	});

	test("a preset mutation persists pools and preserves step assignments", () => {
		const mutation = presetMutation(presetDraft("routed", agents.presets));
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.default_profile).toBe("used");
		expect(mutation.preset.steps).toEqual({ "core.plan": "used" });
		expect(mutation.preset.roles).toEqual({
			"custom.step": { "custom-role": "used" },
		});
		expect(
			mutation.preset.pools?.["core.plan"]?.find((e) => e.default)?.label,
		).toBe("thorough");
	});

	test("structured criteria survive an unchanged preset save", () => {
		const mutation = presetMutation(presetDraft("routed", agents.presets));
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(
			mutation.preset.pools?.["core.plan"]?.find((e) => e.label === "quick")
				?.criteria,
		).toEqual({ what: "small" });
	});

	test("a preset mutation preserves the description", () => {
		const draft = presetDraft("described", {
			described: {
				description: "why it exists",
				pools: {
					"core.plan": [{ label: "quick", profile: "used", default: true }],
				},
			},
		});
		const mutation = presetMutation(draft);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.description).toBe("why it exists");
	});

	test("every reference to a profile is found, including pool entries", () => {
		expect(profileReferences(agents, "used")).toEqual([
			"agents.default_profile",
			"routes.core.plan",
			"role_routes.core.implementation.worker",
			"definition_defaults.openspec",
			"presets.routed.default_profile",
			"presets.routed.steps.core.plan",
			"presets.routed.roles.custom.step.custom-role",
			"presets.routed.pools.core.plan.quick",
			"presets.routed.pools.fusion.plan.strong",
		]);
		expect(profileReferences(agents, "free")).toEqual([
			"presets.routed.pools.core.plan.thorough",
			"presets.routed.pools.fusion.plan.balanced",
		]);
	});

	test("renaming an entry emits a renameFrom the server removes", () => {
		const profile = applyDraftValue(
			profileDraft("old", { runtime: "pi" }),
			"name",
			"new",
		) as ReturnType<typeof profileDraft>;
		const profileMut = profileMutation(profile);
		if (profileMut.kind !== "set-profile")
			throw new Error("expected set-profile");
		expect(profileMut.name).toBe("new");
		expect(profileMut.renameFrom).toBe("old");
	});
});
