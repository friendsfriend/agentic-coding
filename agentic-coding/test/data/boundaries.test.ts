import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Dashboard data layer boundaries (establish-opencode-boundaries, section 4).
 *
 * `src/tui/data/*` is the only place feature code reads server data. It must
 * depend on the gateway port, the contract layer and its own cache — never on
 * the workflow engine, server internals, the filesystem, Git, Herdr, the
 * OpenTUI/Solid component layer or the transitional dash adapters.
 */
const DATA = "src/tui/data";

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

function importSpecifiers(source: string): string[] {
	const specs: string[] = [];
	for (const match of source.matchAll(
		/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*"([^"]+)"/gs,
	))
		specs.push(match[1] ?? "");
	for (const match of source.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g))
		specs.push(match[1] ?? "");
	return specs;
}

describe("dashboard data layer", () => {
	const files = filesUnder(DATA);

	test("the layer is present and small", () => {
		expect(files.length).toBeGreaterThanOrEqual(4);
		expect(files.map((f) => relative(DATA, f)).sort()).toEqual([
			"agents.ts",
			"events.ts",
			"git.ts",
			"herdr.ts",
			"index.ts",
			"review.ts",
			"telemetry.ts",
			"wiki.ts",
			"workflow.ts",
		]);
	});

	test("no data module reaches a runtime, transport or presentation module", () => {
		const forbidden = [
			// pure domain modules the settings surfaces compose: agent profiles,
			// verifier roles, credential prompt formatting, the wiki reader
			/workflow\/(?!contracts|project-catalog|wiki|profiles|credentials|steps|definitions)/,
			// `server/config.ts` holds the pure agents-mutation helpers the
			// settings surface composes; it is the one server module allowed here
			/server\/(?!config)/,
			/^node:/,
			/^bun/,
			/herdr-client/,
			/dash\/(observations|engine)/,
			// `server/config.ts` holds the pure agents-mutation helpers the
			// settings surface composes; it is the one server module allowed here
			/\/engine\.ts$/,
			/\/observations\.ts$/,
			/@ui/,
			/@opentui/,
		];
		const violations: string[] = [];
		for (const file of files)
			for (const spec of importSpecifiers(readFileSync(file, "utf8")))
				if (forbidden.some((re) => re.test(spec)))
					violations.push(`${relative(".", file)} -> ${spec}`);
		expect(violations).toEqual([]);
	});

	test("reads go through the gateway port, not a concrete adapter", () => {
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toContain("BackendClient");
			expect(source).not.toContain("createInProcessGateway");
		}
	});

	test("the cache is the only state holder", () => {
		const index = readFileSync(join(DATA, "index.ts"), "utf8");
		expect(index).toContain("export class DataCache");
		expect(index).toContain("export function configureGateway");
		// events invalidate; they never mutate workflow state
		expect(index).not.toMatch(/dispatch|command|engine/);
	});
});
