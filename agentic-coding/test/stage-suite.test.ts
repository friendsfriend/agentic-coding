// Suite manifest validation and the independent-entry runner
// (`add-stage-flow-replay`, tasks 9.1, 9.4, 9.6).
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readFlowRegistry } from "../src/stage-blocks/flow-registry.ts";
import {
	parseSuiteManifest,
	readSuiteRegistry,
	runSuiteEntries,
	type SuiteEntryResult,
	type SuiteManifest,
	suiteRegistryIssues,
} from "../src/stage-blocks/suite.ts";

const ROOT = path.join(import.meta.dir, "..");

const VALID = {
	version: 1,
	suiteId: "crm-regression",
	parallel: true,
	stopOnFailure: false,
	flows: [
		{ flowId: "customer-address", inputs: { customerId: "C-1001" } },
		{ flowId: "customer-address", inputs: { customerId: "C-1002" } },
		{ flowId: "customer-search", inputs: { query: "acme" } },
	],
};

describe("suite manifest parsing (add-stage-flow-replay)", () => {
	test("accepts a valid manifest and derives unique entry ids", () => {
		const { manifest, issues } = parseSuiteManifest(VALID);
		expect(issues).toEqual([]);
		expect(manifest?.flows.map((entry) => entry.id)).toEqual([
			"customer-address#0",
			"customer-address#1",
			"customer-search#2",
		]);
	});

	test("rejects a non-object, a bad version and a bad suiteId", () => {
		expect(parseSuiteManifest(null).issues[0]?.code).toBe("suite-manifest");
		expect(
			parseSuiteManifest({ ...VALID, version: 2 }).issues.some(
				(issue) => issue.code === "suite-version",
			),
		).toBe(true);
		expect(
			parseSuiteManifest({ ...VALID, suiteId: "CRM Regression" }).issues.some(
				(issue) => issue.code === "suite-id",
			),
		).toBe(true);
	});

	test("rejects an empty flows list and more than the entry limit", () => {
		expect(
			parseSuiteManifest({ ...VALID, flows: [] }).issues.some(
				(issue) => issue.code === "suite-flows",
			),
		).toBe(true);
		const many = Array.from({ length: 51 }, () => ({
			flowId: "customer-address",
		}));
		expect(
			parseSuiteManifest({ ...VALID, flows: many }).issues.some(
				(issue) => issue.code === "suite-flow-limit",
			),
		).toBe(true);
	});

	test("rejects a duplicate explicit entry id", () => {
		const issues = parseSuiteManifest({
			...VALID,
			flows: [
				{ id: "dup", flowId: "customer-address" },
				{ id: "dup", flowId: "customer-search" },
			],
		}).issues;
		expect(issues.some((issue) => issue.code === "suite-entry-id")).toBe(true);
	});

	test("rejects a self dependency and a forward/unknown dependency", () => {
		const selfDep = parseSuiteManifest({
			...VALID,
			parallel: false,
			flows: [{ id: "a", flowId: "customer-address", dependsOn: ["a"] }],
		}).issues;
		expect(
			selfDep.some((issue) => issue.code === "suite-depends-on-self"),
		).toBe(true);
		const forwardDep = parseSuiteManifest({
			...VALID,
			parallel: false,
			flows: [
				{ id: "a", flowId: "customer-address", dependsOn: ["b"] },
				{ id: "b", flowId: "customer-search" },
			],
		}).issues;
		expect(
			forwardDep.some((issue) => issue.code === "suite-depends-on-unknown"),
		).toBe(true);
	});

	test("refuses parallel: true when an entry declares shared data, a sequence or a dependency", () => {
		const sharedData = parseSuiteManifest({
			...VALID,
			flows: [{ flowId: "customer-address", sharedData: true }],
		}).issues;
		expect(
			sharedData.some((issue) => issue.code === "suite-parallel-dependency"),
		).toBe(true);
		const sequenced = parseSuiteManifest({
			...VALID,
			flows: [{ flowId: "customer-address", sequence: 1 }],
		}).issues;
		expect(
			sequenced.some((issue) => issue.code === "suite-parallel-dependency"),
		).toBe(true);
		const dependent = parseSuiteManifest({
			...VALID,
			flows: [
				{ id: "a", flowId: "customer-address" },
				{ id: "b", flowId: "customer-search", dependsOn: ["a"] },
			],
		}).issues;
		expect(
			dependent.some((issue) => issue.code === "suite-parallel-dependency"),
		).toBe(true);
		// The same declarations are fine once the suite opts out of parallel.
		expect(
			parseSuiteManifest({
				...VALID,
				parallel: false,
				flows: [{ flowId: "customer-address", sharedData: true }],
			}).issues,
		).toEqual([]);
	});
});

function entry(id: string, flowId: string): SuiteManifest["flows"][number] {
	return { id, flowId };
}

describe("suite entry runner (add-stage-flow-replay)", () => {
	test("two independent flows both run and the suite passes", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: true,
			stopOnFailure: false,
			flows: [entry("a", "customer-address"), entry("b", "customer-search")],
		};
		const seen: string[] = [];
		const result = await runSuiteEntries(
			manifest,
			async (e) => {
				seen.push(e.id);
				return { id: e.id, flowId: e.flowId, status: "passed" };
			},
			{ maxWorkers: 4 },
		);
		expect(result.status).toBe("passed");
		expect(seen.sort()).toEqual(["a", "b"]);
		expect(result.entries.map((e) => e.status)).toEqual(["passed", "passed"]);
	});

	test("the same flow id twice with different inputs runs both independently", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: true,
			stopOnFailure: false,
			flows: [
				{ id: "a", flowId: "customer-address", inputs: { customerId: "C-1" } },
				{ id: "b", flowId: "customer-address", inputs: { customerId: "C-2" } },
			],
		};
		const inputsSeen: unknown[] = [];
		const result = await runSuiteEntries(
			manifest,
			async (e) => {
				inputsSeen.push(e.inputs);
				return { id: e.id, flowId: e.flowId, status: "passed" };
			},
			{ maxWorkers: 2 },
		);
		expect(result.status).toBe("passed");
		expect(inputsSeen).toEqual([{ customerId: "C-1" }, { customerId: "C-2" }]);
	});

	test("stopOnFailure skips entries not yet started after a failure", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: false,
			stopOnFailure: true,
			flows: [entry("a", "f1"), entry("b", "f2"), entry("c", "f3")],
		};
		const ran: string[] = [];
		const result = await runSuiteEntries(
			manifest,
			async (e) => {
				ran.push(e.id);
				const status: SuiteEntryResult["status"] =
					e.id === "a" ? "failed" : "passed";
				return { id: e.id, flowId: e.flowId, status };
			},
			{ maxWorkers: 1 },
		);
		expect(ran).toEqual(["a"]);
		expect(result.status).toBe("failed");
		expect(result.entries.map((e) => [e.id, e.status])).toEqual([
			["a", "failed"],
			["b", "skipped"],
			["c", "skipped"],
		]);
	});

	test("a refused entry does not cancel another entry without stopOnFailure", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: false,
			stopOnFailure: false,
			flows: [entry("a", "f1"), entry("b", "f2")],
		};
		const result = await runSuiteEntries(
			manifest,
			async (e) => ({
				id: e.id,
				flowId: e.flowId,
				status: e.id === "a" ? "refused" : "passed",
			}),
			{ maxWorkers: 1 },
		);
		expect(result.status).toBe("failed");
		expect(result.entries.map((e) => e.status)).toEqual(["refused", "passed"]);
	});

	test("a worker cap bounds concurrency", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: true,
			stopOnFailure: false,
			flows: Array.from({ length: 6 }, (_, index) =>
				entry(`e${index}`, "customer-address"),
			),
		};
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await runSuiteEntries(
			manifest,
			async (e) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return { id: e.id, flowId: e.flowId, status: "passed" };
			},
			{ maxWorkers: 2 },
		);
		expect(result.status).toBe("passed");
		expect(maxInFlight).toBeLessThanOrEqual(2);
		expect(result.entries).toHaveLength(6);
	});

	test("a non-parallel suite never exceeds one in-flight entry", async () => {
		const manifest: SuiteManifest = {
			version: 1,
			suiteId: "s",
			parallel: false,
			stopOnFailure: false,
			flows: [entry("a", "f1"), entry("b", "f2"), entry("c", "f3")],
		};
		let inFlight = 0;
		let maxInFlight = 0;
		await runSuiteEntries(
			manifest,
			async (e) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 1));
				inFlight -= 1;
				return { id: e.id, flowId: e.flowId, status: "passed" };
			},
			{ maxWorkers: 8 },
		);
		expect(maxInFlight).toBe(1);
	});
});

describe("suite registry (add-stage-flow-replay)", () => {
	test("the checked-in crm-smoke suite is valid against the checked-in flows", () => {
		const flows = readFlowRegistry(ROOT);
		expect(flows.issues).toEqual([]);
		const suites = readSuiteRegistry(ROOT);
		expect(suites.issues).toEqual([]);
		const smoke = suites.entries.find(
			(entry) => entry.manifest.suiteId === "crm-smoke",
		);
		expect(smoke).toBeDefined();
		if (!smoke) throw new Error("missing crm-smoke suite");
		expect(suiteRegistryIssues(smoke.manifest, flows.entries)).toEqual([]);
		expect(smoke.manifest.flows.map((entry) => entry.flowId)).toEqual([
			"customer-address",
			"customer-search",
		]);
	});

	test("refuses an unknown flow id and input values that do not fit the flow's schema", () => {
		const flows = readFlowRegistry(ROOT);
		const { manifest } = parseSuiteManifest({
			version: 1,
			suiteId: "s",
			flows: [
				{ id: "a", flowId: "no-such-flow" },
				{
					id: "b",
					flowId: "customer-search",
					inputs: { path: "missing-leading-slash" },
				},
			],
		});
		if (!manifest) throw new Error("expected a valid manifest shape");
		const issues = suiteRegistryIssues(manifest, flows.entries);
		expect(issues.some((issue) => issue.code === "suite-flow-unknown")).toBe(
			true,
		);
		expect(issues.some((issue) => issue.code === "suite-flow-inputs")).toBe(
			true,
		);
	});
});
