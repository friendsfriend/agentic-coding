import { expect, test } from "bun:test";
import {
	collectProductionLogs,
	compileProductionLogQuery,
	type ProductionRead,
	productionReceipt,
} from "../src/agent-host/digest-log-sources.ts";
import type { DigestProductionSource } from "../src/scheduling/digest-settings.ts";

const nominalDue = Date.parse("2026-03-30T07:00:00Z"),
	at = nominalDue - 1000;
const azure: DigestProductionSource = {
	provider: "azure-monitor",
	environment: "production",
	environmentField: "environment",
	environmentValue: "production",
	services: ["verified-prod-service"],
	provenance: "reviewed-config:synthetic",
};
const nr: DigestProductionSource = { ...azure, provider: "new-relic" };
const file = "/tmp/mapi-azure-results/query-123.ndjson";
function receipt(count: number, path = file) {
	return `✅ Query complete — ${count} rows written to file.\n\nFile:    ${path}\nRows:    ${count}\nColumns: service, signature, count, first, last, severity\n\nUse read_azure_results with this file path to analyse the data.`;
}
function row(index = 0) {
	return {
		service: "verified-prod-service",
		signature: `SyntheticFailure${index}`,
		count: 7,
		first: new Date(at).toISOString(),
		last: new Date(at).toISOString(),
		severity: 3,
	};
}
function page(items: unknown[], offset: number, total: number) {
	const last = offset + items.length - 1;
	return `(rows ${offset}–${last} of ${total} — ${last === total ? "end of file" : `${total - last} rows remaining`})\n\n${items.map((item) => JSON.stringify(item)).join("\n")}`;
}
test("compiled fixed telemetry queries pin verified production, services and exact nominal half-open window; no injection or QA widening", () => {
	const kql = compileProductionLogQuery(azure, nominalDue),
		nrql = compileProductionLogQuery(nr, nominalDue);
	expect(kql.query).toContain(
		'tostring(Properties["environment"]) == "production"',
	);
	expect(kql.query).toContain('AppRoleName in ("verified-prod-service")');
	expect(kql.query).toContain(
		"TimeGenerated >= datetime(2026-03-29T07:00:00.000Z) and TimeGenerated < datetime(2026-03-30T07:00:00.000Z)",
	);
	expect(nrql.query).toContain("`environment` = 'production'");
	expect(nrql.query).toContain("FACET appName, if(`error.class` IS NOT NULL");
	expect(nrql.query).toContain("'__missing_signature__'");
	for (const source of [
		{ ...azure, environmentValue: 'production" or true' },
		{ ...nr, services: ["x') OR true"] },
		{ ...azure, environment: "qa" },
		{ ...azure, environmentValue: "qa" },
		{ ...azure, provenance: "" },
		{ ...azure, environmentField: "arbitrary" },
	])
		expect(() =>
			compileProductionLogQuery(source as DigestProductionSource, nominalDue),
		).toThrow();
});
test("NRQL missing signature bucket preserves observed counts with an explicit context gap instead of silently excluding null facets", async () => {
	const path = "/tmp/mapi-newrelic-results/nrql-1.ndjson";
	const result = await collectProductionLogs(
		[nr],
		nominalDue,
		async (operation) =>
			operation === "new-relic-query"
				? { filePath: path, rowCount: 1 }
				: page(
						[
							{
								facet: ["verified-prod-service", "__missing_signature__"],
								count: 7,
								first: at,
								last: at,
							},
						],
						1,
						1,
					),
	);
	expect(result.events).toHaveLength(1);
	expect(result.events[0]?.count).toBe(7);
	expect(result.events[0]?.title).toContain("source signature unavailable");
	expect(result.coverage[1]).toMatchObject({
		status: "partial",
		attempts: 2,
		failures: 0,
	});
	expect(result.coverage[1]?.diagnostics).toContain(
		"production-signature-unavailable",
	);
});
test("actual Markdown query receipts and paginated NDJSON transport retain counts and exhaust beyond forty without exposing source text as authority", async () => {
	const calls: { operation: ProductionRead; args: Record<string, unknown> }[] =
		[];
	const result = await collectProductionLogs(
		[azure],
		nominalDue,
		async (operation, args) => {
			calls.push({ operation, args });
			if (operation === "azure-query")
				return { output: [{ type: "text", text: receipt(201) }] };
			const offset = Number(args.offset),
				limit = Number(args.limit);
			return page(
				Array.from({ length: limit }, (_, index) => row(offset + index)),
				offset,
				201,
			);
		},
	);
	expect(calls.map((call) => call.operation)).toEqual([
		"azure-query",
		"azure-results",
		"azure-results",
	]);
	expect(calls[1]?.args).toEqual({ filePath: file, offset: 1, limit: 200 });
	expect(calls[2]?.args).toEqual({ filePath: file, offset: 201, limit: 1 });
	expect(result.events).toHaveLength(201);
	expect(result.events[0]?.count).toBe(7);
	expect(result.events[0]?.countExact).toBe(true);
	expect(result.coverage[0]?.pages).toBe(2);
	expect(result.coverage[0]?.diagnostics).toContain(
		"production-deep-link-unavailable",
	);
	expect(result.coverage[1]?.status).toBe("unavailable");
	expect(
		productionReceipt(
			"✅ NRQL query complete — 1 rows written to file.\n\nFile:       /tmp/mapi-newrelic-results/nrql-1.ndjson\nRows:       1\nColumns:    count\nTime window: 1 → 2",
			"new-relic",
		)?.rowCount,
	).toBe(1);
});
test("missing provenance, forged/arbitrary/cross-provider receipt paths, mismatched pages and foreign service rows never become empty success", async () => {
	let calls = 0;
	const missing = await collectProductionLogs([], nominalDue, async () => {
		calls++;
		return {};
	});
	expect(calls).toBe(0);
	expect(missing.coverage.every((item) => item.status === "unavailable")).toBe(
		true,
	);
	for (const path of [
		"/etc/passwd",
		"/tmp/arbitrary.ndjson",
		"/tmp/mapi-newrelic-results/nrql-1.ndjson",
		"/tmp/../mapi-azure-results/query-1.ndjson",
	]) {
		const result = await collectProductionLogs(
			[azure],
			nominalDue,
			async () => {
				calls++;
				return receipt(1, path);
			},
		);
		expect(result.events).toHaveLength(0);
		expect(result.coverage[0]?.status).toBe("unavailable");
	}
	const badPage = await collectProductionLogs(
		[azure],
		nominalDue,
		async (operation) =>
			operation === "azure-query" ? receipt(1) : page([row()], 2, 1),
	);
	expect(badPage.events).toHaveLength(0);
	expect(badPage.coverage[0]?.status).not.toBe("success");
	const qa = await collectProductionLogs(
		[azure],
		nominalDue,
		async (operation) =>
			operation === "azure-query"
				? receipt(1)
				: page([{ ...row(), service: "qa-service" }], 1, 1),
	);
	expect(qa.events).toHaveLength(0);
	expect(qa.coverage[0]?.diagnostics).toContain(
		"production-aggregate-row-invalid",
	);
});
test("transport rejection counts initial/later failures, retains earlier evidence and continues the other provider without leaking errors", async () => {
	for (const failInitial of [true, false]) {
		const collected = await collectProductionLogs(
			[azure, nr],
			nominalDue,
			async (operation, args) => {
				if (operation === "azure-query") {
					if (failInitial) throw new Error("secret transport details");
					return receipt(201);
				}
				if (operation === "azure-results") {
					if (args.offset !== 1) throw new Error("secret transport details");
					return page(
						Array.from({ length: 200 }, (_, i) => row(i)),
						1,
						201,
					);
				}
				if (operation === "new-relic-query")
					return {
						filePath: "/tmp/mapi-newrelic-results/nrql-1.ndjson",
						rowCount: 0,
					};
				throw new Error("unexpected operation");
			},
		);
		expect(collected.coverage[0]).toMatchObject({
			status: failInitial ? "unavailable" : "partial",
			attempts: failInitial ? 1 : 3,
			failures: 1,
			items: failInitial ? 0 : 200,
		});
		expect(collected.events).toHaveLength(failInitial ? 0 : 200);
		expect(collected.coverage[1]).toMatchObject({
			status: "success",
			attempts: 1,
			failures: 0,
		});
		expect(JSON.stringify(collected)).not.toContain("secret transport details");
	}
});
test("aggregate ceiling and malformed tail retain covered evidence with explicit lower bounds, never claim complete empty logs", async () => {
	const capped = await collectProductionLogs(
		[azure],
		nominalDue,
		async (operation, args) =>
			operation === "azure-query"
				? receipt(1001)
				: page(
						Array.from({ length: Number(args.limit) }, (_, index) =>
							row(Number(args.offset) + index),
						),
						Number(args.offset),
						1001,
					),
	);
	expect(capped.events).toHaveLength(1000);
	expect(capped.events.every((item) => item.countExact === false)).toBe(true);
	expect(capped.coverage[0]?.truncated).toBe(true);
	const broken = await collectProductionLogs(
		[azure],
		nominalDue,
		async (operation, args) =>
			operation === "azure-query"
				? receipt(201)
				: args.offset === 1
					? page(
							Array.from({ length: 200 }, (_, index) => row(index)),
							1,
							201,
						)
					: "unrecognized transport",
	);
	expect(broken.events).toHaveLength(200);
	expect(broken.coverage[0]?.status).toBe("partial");
	const empty = await collectProductionLogs([azure], nominalDue, async () =>
		receipt(0),
	);
	expect(empty.coverage[0]?.status).toBe("success");
	expect(empty.coverage[0]?.items).toBe(0);
	expect(empty.coverage[1]?.status).toBe("unavailable");
});
