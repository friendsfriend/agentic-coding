import { describe, expect, test } from "bun:test";
import {
	applyDraftValue,
	complexityKey,
	type PresetDraft,
	type ProfileDraft,
	presetDraft,
	presetFields,
	presetMutation,
	profileDraft,
	profileMutation,
	profileReferences,
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
			roles: {
				"core.verification": { "quality-verifier": "free" },
				"custom.step": { "custom-role": "used" },
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

	test("changing a runtime clears the previous runtime's executable and extensions", () => {
		const draft = profileDraft("p", {
			runtime: "pi",
			executable: "/usr/bin/pi",
			extensions: ["ext"],
			tools: ["read"],
			capabilities: ["shell"],
		});
		const next = applyDraftValue(draft, "runtime", "opencode") as ProfileDraft;
		// opencode rejects pi's `extensions`, and the stale pi executable must not
		// be spawned for the opencode harness.
		expect(next.executable).toBeUndefined();
		expect(next.extensions).toBeUndefined();
		// Fields every runtime accepts survive the switch.
		expect(next.tools).toEqual(["read"]);
		expect(next.capabilities).toEqual(["shell"]);
	});

	test("a preset draft keeps role tables the form does not edit", () => {
		const draft = presetDraft("routed", agents.presets);
		expect(draft.fusionRoles).toEqual({});
		expect(draft.roles).toEqual({ "quality-verifier": "free" });
		expect(draft.otherRoles).toEqual({
			"custom.step": { "custom-role": "used" },
		});
	});

	test("a prefilled preset draft loads stored complexity mappings", () => {
		const draft = presetDraft("classified", {
			classified: { easy: "used", critical: "free" },
		});
		expect(draft.complexities).toEqual({ easy: "used", critical: "free" });
	});

	test("the preset form offers a complexity field per category after the default profile", () => {
		const fields = presetFields(["used", "free"]);
		const labels = fields.map((field) => field.label);
		const defaultIndex = labels.indexOf("Default profile (fallback)");
		expect(labels.slice(defaultIndex + 1, defaultIndex + 5)).toEqual([
			"Complexity easy",
			"Complexity medium",
			"Complexity hard",
			"Complexity critical",
		]);
		const hard = fields.find((field) => field.label === "Complexity hard");
		expect(hard?.options).toEqual(["", "used", "free"]);
	});

	test("applyDraftValue sets one complexity mapping", () => {
		const draft = presetDraft("new", {});
		const next = applyDraftValue(
			draft,
			complexityKey("hard"),
			"used",
		) as PresetDraft;
		expect(next.complexities).toEqual({ hard: "used" });
	});
});

describe("agent preset validation", () => {
	test("a blank name is refused in place", () => {
		const draft = profileDraft("", undefined);
		expect(validateDraft(draft, [])).toEqual({ name: "Name is required" });
	});

	test("the reserved built-in name is refused", () => {
		const draft = presetDraft("use-default-model", agents.presets);
		expect(validateDraft(draft, [])).toEqual({
			name: '"use-default-model" is reserved',
		});
	});

	test("a duplicate name is refused for a new entry but allowed when unchanged", () => {
		expect(validateDraft(profileDraft("used", undefined), ["used"])).toEqual({
			name: 'A profile named "used" already exists',
		});
		const existing = agents.profiles.used
			? profileDraft("used", agents.profiles.used)
			: undefined;
		expect(existing && validateDraft(existing, ["used"])).toEqual({});
	});
});

describe("agent preset mutations", () => {
	test("a profile mutation trims the name and omits empty optional fields", () => {
		const draft = profileDraft("", undefined);
		const next = applyDraftValue(
			applyDraftValue(draft, "name", "  trimmed  "),
			"runtime",
			"opencode",
		) as ProfileDraft;
		expect(profileMutation(next)).toEqual({
			kind: "set-profile",
			name: "trimmed",
			profile: { runtime: "opencode" },
		});
	});

	test("a profile mutation carries fields the form does not edit", () => {
		const draft = profileDraft("p", {
			runtime: "pi",
			executable: "/usr/bin/pi",
			model: "vendor/model",
			tools: ["read"],
			extensions: ["ext"],
			capabilities: ["shell"],
		});
		const mutation = profileMutation(draft);
		if (mutation.kind !== "set-profile")
			throw new Error("expected set-profile");
		expect(mutation.profile).toMatchObject({
			executable: "/usr/bin/pi",
			tools: ["read"],
			extensions: ["ext"],
			capabilities: ["shell"],
		});
	});

	test("a preset mutation preserves the description", () => {
		const draft = presetDraft("described", {
			described: { description: "why it exists" },
		});
		const mutation = presetMutation(draft);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.description).toBe("why it exists");
	});

	test("a preset mutation drops empty references and preserves other role tables", () => {
		const draft = presetDraft("routed", agents.presets);
		const next = applyDraftValue(draft, "step:core.plan", "") as PresetDraft;
		const mutation = presetMutation(next);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.name).toBe("routed");
		expect(mutation.preset.default_profile).toBe("used");
		expect(mutation.preset.steps).toBeUndefined();
		expect(mutation.preset.roles).toEqual({
			"custom.step": { "custom-role": "used" },
			"core.verification": { "quality-verifier": "free" },
		});
	});

	test("every reference to a profile is found", () => {
		expect(profileReferences(agents, "used")).toEqual([
			"agents.default_profile",
			"routes.core.plan",
			"role_routes.core.implementation.worker",
			"definition_defaults.openspec",
			"presets.routed.default_profile",
			"presets.routed.steps.core.plan",
			"presets.routed.roles.custom.step.custom-role",
		]);
		expect(profileReferences(agents, "free")).toEqual([
			"presets.routed.roles.core.verification.quality-verifier",
		]);
	});

	test("a preset mutation writes only non-empty complexity mappings", () => {
		const draft = applyDraftValue(
			applyDraftValue(presetDraft("new", {}), complexityKey("easy"), "used"),
			complexityKey("critical"),
			"",
		) as PresetDraft;
		const mutation = presetMutation(draft);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.easy).toBe("used");
		expect(mutation.preset.medium).toBeUndefined();
		expect(mutation.preset.hard).toBeUndefined();
		expect(mutation.preset.critical).toBeUndefined();
	});

	test("a preset draft round-trips a stored complexity mapping", () => {
		const mutation = presetMutation(
			presetDraft("classified", {
				classified: { easy: "used", critical: "free" },
			}),
		);
		if (mutation.kind !== "set-preset") throw new Error("expected set-preset");
		expect(mutation.preset.easy).toBe("used");
		expect(mutation.preset.critical).toBe("free");
		expect(mutation.preset.medium).toBeUndefined();
		expect(mutation.preset.hard).toBeUndefined();
	});

	test("a profile referenced only by a complexity mapping is reported", () => {
		const config: AgentsConfig = {
			profiles: { used: { runtime: "pi" } },
			presets: { classified: { easy: "used", critical: "used" } },
		};
		expect(profileReferences(config, "used")).toEqual([
			"presets.classified.easy",
			"presets.classified.critical",
		]);
	});

	test("renaming an entry emits a renameFrom the server removes", () => {
		const profile = applyDraftValue(
			profileDraft("old", { runtime: "pi" }),
			"name",
			"new",
		) as ProfileDraft;
		const profileMut = profileMutation(profile);
		if (profileMut.kind !== "set-profile")
			throw new Error("expected set-profile");
		expect(profileMut.name).toBe("new");
		expect(profileMut.renameFrom).toBe("old");

		const preset = applyDraftValue(
			presetDraft("old", { old: {} }),
			"name",
			"new",
		) as PresetDraft;
		const presetMut = presetMutation(preset);
		if (presetMut.kind !== "set-preset") throw new Error("expected set-preset");
		expect(presetMut.name).toBe("new");
		expect(presetMut.renameFrom).toBe("old");
	});

	test("an unchanged name is not emitted as a rename", () => {
		const mutation = profileMutation(profileDraft("same", { runtime: "pi" }));
		if (mutation.kind !== "set-profile")
			throw new Error("expected set-profile");
		expect(mutation.renameFrom).toBeUndefined();
	});
});
