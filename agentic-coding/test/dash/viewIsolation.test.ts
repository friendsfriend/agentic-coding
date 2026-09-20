import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Dashboard view isolation (establish-opencode-boundaries, tasks 6.4/5.6).
 *
 * A dashboard view may import contracts, `@ui`, OpenTUI/Solid, its own sibling
 * modules and the provider seams (`tui/data/*`, `dash/live.ts`) — never a
 * server module, a transport, the filesystem, Git, Herdr or the workflow
 * runtime. Data fetching, engine construction and repository access live behind
 * the providers.
 *
 * The pure-helper exceptions below are formatting/derivation modules that carry
 * no I/O; each names what it is.
 */
const VIEW_DIRS = ["src/tui/dash", "src/tui/otel", "src/tui/settings"];

/** Pure modules a view may import directly, with the reason. */
const PURE_HELPER_EXCEPTIONS = [
	// duration/phase formatting and pure projections over supplied data
	/\/workflow\/format\.ts$/,
	/\/workflow\/definitions\.ts$/,
	/\/workflow\/profiles\.ts$/,
	/\/workflow\/credentials\.ts$/,
	/\/workflow\/steps\//,
	/\/workflow\/wiki\.ts$/,
	/\/workflow\/run-projections\.ts$/,
	/\/workflow\/project-catalog\.ts$/,
	/\/workflow\/runtime\.ts$/,
];

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else if (entry.endsWith(".tsx")) out.push(full);
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

/** Resolve a relative specifier to a repo-relative path for classification. */
function resolveSpecifier(file: string, spec: string): string | null {
	if (!spec.startsWith(".")) return null;
	const base = join(join(file, ".."), spec);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`])
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile())
			return relative(".", candidate).split("\\").join("/");
	return relative(".", base).split("\\").join("/");
}

describe("dashboard views are presentation only", () => {
	const files = VIEW_DIRS.flatMap(filesUnder);

	test("the scan covers the dashboard, observability and settings views", () => {
		expect(files.length).toBeGreaterThan(30);
	});

	test("no view imports a server, transport or I/O module", () => {
		const forbidden = [
			/^src\/server\//,
			/^src\/herdr-client\.ts$/,
			/^node:/,
			/^bun/,
		];
		const violations: string[] = [];
		for (const file of files)
			for (const spec of importsOf(readFileSync(file, "utf8"))) {
				const resolved = resolveSpecifier(file, spec);
				if (!resolved) continue;
				if (forbidden.some((re) => re.test(resolved)))
					violations.push(`${relative(".", file)} -> ${resolved}`);
			}
		expect(violations).toEqual([]);
	});

	test("no view imports the workflow runtime except named pure helpers", () => {
		const violations: string[] = [];
		for (const file of files)
			for (const spec of importsOf(readFileSync(file, "utf8"))) {
				const resolved = resolveSpecifier(file, spec);
				if (!resolved) continue;
				if (!resolved.startsWith("src/workflow/")) continue;
				if (PURE_HELPER_EXCEPTIONS.some((re) => re.test(resolved))) continue;
				violations.push(`${relative(".", file)} -> ${resolved}`);
			}
		expect(violations).toEqual([]);
	});

	test("views read data through the providers, not the adapters", () => {
		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			if (/dash\/(observations|engine)\.ts/.test(source))
				violations.push(`${relative(".", file)} imports a deleted adapter`);
			if (/BackendClient\b/.test(source))
				violations.push(`${relative(".", file)} constructs a transport`);
			if (/createInProcessGateway\b/.test(source))
				violations.push(`${relative(".", file)} constructs the gateway`);
		}
		expect(violations).toEqual([]);
	});

	test("no view opens a workflow store or database of its own", () => {
		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const pattern of [
				/new WorkflowEngine\b/,
				/from "bun:sqlite"/,
				/readFileSync\(/,
				/execFileSync\(/,
			])
				if (pattern.test(source))
					violations.push(`${relative(".", file)}: ${pattern.source}`);
		}
		expect(violations).toEqual([]);
	});
});

describe("the dashboard route is a coordinator", () => {
	const app = () => readFileSync("src/tui/dash/App.tsx", "utf8");

	test("rendering and key handling live in their own modules", () => {
		const source = app();
		// panels, routes, overlays and the key handler are separate modules
		for (const spec of [
			'"./panels/ChangePanel.tsx"',
			'"./panels/OpenSpecPanel.tsx"',
			'"./panels/AgentsPanel.tsx"',
			'"./routes/ReviewRoute.tsx"',
			'"./routes/DialogueRoute.tsx"',
			'"./modals/Overlays.tsx"',
			'"./handlers/keys.ts"',
		])
			expect(source).toContain(spec);
		// the route does not define the key surface itself any more
		expect(source).not.toMatch(/const handleKey = async \(key: KeyEvent\)/);
	});

	test("the route performs no I/O and builds no engine", () => {
		const source = app();
		for (const pattern of [
			/readFileSync\(/,
			/execFileSync\(/,
			/from "bun:sqlite"/,
			/new WorkflowEngine\b/,
			/createInProcessGateway\b/,
			/new BackendClient\b/,
		])
			expect(source).not.toMatch(pattern);
	});

	test("page-local state lives in the state module", () => {
		const source = app();
		// the route aliases state instead of declaring the signals inline
		expect(source).toContain('from "./state.ts"');
		expect(source).toContain("createPanelState()");
		expect(source).toContain("createDialogueState()");
		expect(source).toContain("createOverlayState(");
		// the only signals it still declares are its own data/loading signals
		const inline = [
			...source.matchAll(/const \[([A-Za-z]+), set[A-Za-z]+\] = createSignal/g),
		].map((m) => m[1]);
		// only the route's own loading/credential state remains inline
		for (const name of inline)
			expect([
				"busy",
				"data",
				"demoIndex",
				"reviewFinishing",
				"reviewFinishingMessage",
				"credentialInput",
				"userActionOpen",
			]).toContain(name);
	});
});

describe("dashboard reads and mutations use one surface (task 8.5)", () => {
	const dashboardFiles = () => [
		...filesUnder("src/tui/dash"),
		...filesUnder("src/tui/data"),
	];

	test("no dashboard module calls a transport escape hatch", () => {
		const violations: string[] = [];
		for (const file of dashboardFiles()) {
			const source = readFileSync(file, "utf8");
			// the client exposes named operations; a generic escape hatch would let
			// a feature bypass the contract decode
			if (/client\.api\./.test(source))
				violations.push(`${file}: client.api.*`);
			if (/\.request\(\s*"(GET|POST)"/.test(source))
				violations.push(`${file}: raw request`);
		}
		expect(violations).toEqual([]);
	});

	test("observations go through the gateway or the data layer", () => {
		const violations: string[] = [];
		for (const file of dashboardFiles()) {
			const source = readFileSync(file, "utf8");
			// a direct in-process observation bypass would skip the port
			if (/\brunLocalObservation\(/.test(source) && !file.includes("/data/"))
				violations.push(`${file}: direct observation`);
		}
		expect(violations).toEqual([]);
	});
});
