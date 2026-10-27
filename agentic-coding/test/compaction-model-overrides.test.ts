import { describe, expect, test } from "bun:test";
import {
	compactionConfigForModel,
	parseCompactionConfig,
	resolveCompactionCeiling,
	resolveCompactionSection,
	resolveModelCompactionPolicies,
	validateCompactionConfig,
} from "../src/workflow/compaction.ts";

describe("exact model compaction policies", () => {
	test("mixed windows, slash-containing model IDs, provider identity and unknown fallback stay independent", () => {
		const config = parseCompactionConfig({
			keepRecentTokens: "15%",
			modelOverrides: {
				"one/family/model": { reserveTokens: "40%" },
				"two/family/model": { reserveTokens: 45000 },
				"unknown/model": { keepRecentTokens: 6000 },
			},
		});
		const policies = resolveModelCompactionPolicies(config, {
			"one/family/model": 1_000_000,
			"two/family/model": 100_000,
		});
		expect(policies.reserveTokens).toBe(32000);
		expect(policies.keepRecentTokens).toBe(20000);
		expect(policies.modelOverrides["one/family/model"]).toMatchObject({
			reserveTokens: 400_000,
			keepRecentTokens: 75000,
		});
		expect(policies.modelOverrides["two/family/model"]).toMatchObject({
			reserveTokens: 45000,
			keepRecentTokens: 15000,
		});
		expect(policies.modelOverrides["unknown/model"]).toMatchObject({
			reserveTokens: 32000,
			keepRecentTokens: 6000,
		});
		expect(
			resolveModelCompactionPolicies(config, {}).modelOverrides[
				"one/family/model"
			]?.reserveTokens,
		).toBe(32000);
	});
	test("whole-section source precedence then exact field precedence; live edits do not mutate old results", () => {
		const selected = resolveCompactionSection(
			{ reserveTokens: 60000 },
			{
				keepRecentTokens: 8000,
				modelOverrides: { "p/m": { backgroundTokens: 0 } },
			},
		);
		expect(selected.source).toBe("agentHost");
		const first = resolveModelCompactionPolicies(selected.config, {
			"p/m": 200_000,
		});
		expect(first.modelOverrides["p/m"]).toEqual({
			enabled: true,
			reserveTokens: 60000,
			keepRecentTokens: 8000,
			backgroundTokens: 0,
		});
		selected.config.reserveTokens = 41000;
		const second = resolveModelCompactionPolicies(selected.config, {
			"p/m": 100_000,
		});
		expect(second.modelOverrides["p/m"]?.reserveTokens).toBe(41000);
		expect(first.modelOverrides["p/m"]?.reserveTokens).toBe(60000);
	});
	test("exact enabled and cost ceiling use the same effective config", () => {
		const config = parseCompactionConfig({
			modelOverrides: {
				"p/off": { enabled: false },
				"p/cheap": { ceilingTokens: 50000 },
			},
		});
		expect(
			resolveModelCompactionPolicies(config, {}).modelOverrides["p/off"]
				?.enabled,
		).toBe(false);
		expect(
			resolveCompactionCeiling(
				compactionConfigForModel(config, "p/off"),
				1_000_000,
			).inactive,
		).toBe("disabled");
		expect(
			resolveCompactionCeiling(
				compactionConfigForModel(config, "p/cheap"),
				1_000_000,
			).ceilingTokens,
		).toBe(50000);
	});
	test("invalid tables, identities, token forms, nested entries and inherited cross-field conflicts are diagnosed", () => {
		for (const modelOverrides of [
			false,
			{ bad: {} },
			{ "p/m": { reserveTokens: "wat" } },
			{ "p/m": { modelOverrides: {} } },
			{ "p/m": { ceilingTokens: "20%" } },
		])
			expect(
				validateCompactionConfig({ modelOverrides }).length,
			).toBeGreaterThan(0);
		expect(
			validateCompactionConfig({
				keepRecentTokens: 30000,
				modelOverrides: { "p/m": { ceilingTokens: 20000 } },
			}).some((error) => error.message.includes("modelOverrides.p/m")),
		).toBe(true);
		expect(
			validateCompactionConfig({
				modelOverrides: { "p/family/model": { reserveTokens: "30%" } },
			}),
		).toEqual([]);
	});
});
