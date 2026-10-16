import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Presentational package boundaries (establish-opencode-boundaries, tasks
 * 7.1-7.3).
 *
 * `packages/ui` is the shared framework every surface renders from. It owns its
 * structural prop types, depends on no application, domain, server or workflow
 * module, and its components stay props-in/callbacks-out.
 */
const PKG = "packages/ui";

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

function importsOf(source: string): string[] {
	const specs: string[] = [];
	for (const match of source.matchAll(
		/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*"([^"]+)"/gs,
	))
		specs.push(match[1] ?? "");
	for (const match of source.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g))
		specs.push(match[1] ?? "");
	return specs;
}

describe("packages/ui has no application dependency", () => {
	const files = filesUnder(join(PKG, "src"));

	test("the package declares no domain or application dependency", () => {
		const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const declared = { ...pkg.dependencies, ...pkg.devDependencies };
		expect(Object.keys(declared).sort()).toEqual([
			"@opentui/core",
			"@opentui/keymap",
			"@opentui/solid",
			"solid-js",
		]);
	});

	test("no framework module imports the application, server or workflow", () => {
		const forbidden = [
			/^@devenv\//,
			/^@ui$/, // the barrel is for consumers; internal imports are relative
			/\/src\/server\//,
			/\/src\/workflow\//,
			/\/src\/tui\//,
			/\/src\/contracts\//,
			// the package's own colocated tests use the runner
			/^bun:(?!test)/,
		];
		const violations: string[] = [];
		for (const file of files) {
			if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
			for (const spec of importsOf(readFileSync(file, "utf8")))
				if (forbidden.some((re) => re.test(spec)))
					violations.push(`${relative(".", file)} -> ${spec}`);
		}
		expect(violations).toEqual([]);
	});

	test("framework components stay props-in and callbacks-out", () => {
		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const pattern of [
				/fetch\(/,
				/readFileSync\(/,
				/execFileSync\(/,
				/new BackendClient\b/,
				/createInProcessGateway\b/,
			])
				if (pattern.test(source))
					violations.push(`${relative(".", file)}: ${pattern.source}`);
		}
		expect(violations).toEqual([]);
	});

	test("the structural props the views render live in the package", () => {
		const types = readFileSync(join(PKG, "src/types.ts"), "utf8");
		for (const name of ["Provider", "App", "ChangeRequest", "Issue", "Job"])
			expect(types).toContain(`export interface ${name}`);
		// the barrel exports them for the surfaces that map their records
		expect(readFileSync(join(PKG, "src/index.ts"), "utf8")).toContain(
			'from "./types.ts";',
		);
	});
});

/**
 * The mouse layer is one implementation for every family
 * (`tui-shared-primitives`). The environment package renders `@ui` directly; a
 * forked `useRowMouse`/`useTap`/row handler there would reintroduce the
 * divergence the shared layer removed, so the source is asserted, not just the
 * barrel's `toBe` identity in `test/dash/devenvUiPrimitives.test.ts`.
 */
describe("the environment package carries no forked pointer layer", () => {
	const files = filesUnder(join("packages/devenv", "cli", "src"));

	test("no local pointer-layer declaration exists", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const declaration of [
				/\bfunction\s+useRowMouse\b/,
				/\bconst\s+useRowMouse\s*=/,
				/\bfunction\s+useTap\b/,
				/\bconst\s+useTap\s*=/,
				/\bclassifyPointerGesture\b\s*\(/,
				/\bbackdropDismiss\b\s*\(/,
			])
				if (declaration.test(source)) offenders.push(relative(".", file));
		}
		expect(offenders).toEqual([]);
	});

	test("pointer primitives are imported from the shared package", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const spec of importsOf(readFileSync(file, "utf8"))) {
				if (
					!/(useRowMouse|useTap|useWheelScroll|clickSemantics|dismissPolicy)/.test(
						spec,
					)
				)
					continue;
				if (
					spec === "@ui" ||
					spec.endsWith("/tui/ui.ts") ||
					spec.endsWith("/tui/ui")
				)
					continue;
				offenders.push(`${relative(".", file)} -> ${spec}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
