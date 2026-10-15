// The isolation contract's executable half (docs/test-isolation.md).
//
// `test/support/isolate-config-root.ts` points every location a test can write to
// at a throwaway directory and fails the run when the developer's real
// configuration directory grew. This file is the other half: it fails when the
// *resolution* regresses, so a default that quietly stops following the
// configuration root — a hard-coded `~/.config/agentic-coding/wiki` was exactly
// that, and it is what put thousands of test workflow targets into the live
// dashboard's registry — cannot come back unnoticed.
//
// It asserts the state of *its own process*, which only holds when it owns that
// process: the suite runner gives every non-render file a job of its own
// (`planJobs` in `scripts/test-plan.ts` shards only `test/dash`, `test/otel` and
// `test/app`). A sibling file that clears the configuration root — several do,
// deliberately — reaches these assertions when several files are handed to one
// `bun test` process by hand.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigRoot } from "../src/config-root.ts";
import { DEFAULT_CONFIG } from "../src/workflow/effects.ts";
import {
	canonicalStorePath,
	recordWorkflowTarget,
	targetRegistryDirectory,
	WIKI_WORKFLOW_TARGET,
	wikiWorkflowDataRoot,
} from "../src/workflow/runtime.ts";
import {
	defaultWikiRoot,
	wikiRoot,
	writeConcept,
} from "../src/workflow/wiki.ts";
import {
	assertRealConfigUntouched,
	realConfigRoot,
	targetRegistryDirectory as registryInside,
	snapshotRealConfig,
} from "./support/real-config-guard.ts";

/** The developer's own home. The preload and the suite runner export it; a test
 * process that somehow sees neither refuses rather than comparing against its own
 * sandbox and calling that a pass. */
function realHome(): string {
	const home = process.env.AGENTIC_CODING_TEST_REAL_HOME;
	if (!home) throw new Error("AGENTIC_CODING_TEST_REAL_HOME is not exported");
	return home;
}

function tempDirectory(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** True when `location` is inside `root`, comparing resolved paths because the
 * same directory has two spellings on this platform (`$TMPDIR` is a symlink, and
 * `wikiWorkflowDataRoot()` realpath-resolves what `wikiRoot()` does not). */
function inside(root: string, location: string): boolean {
	return location === root || location.startsWith(`${root}${path.sep}`);
}

describe("configuration-root isolation", () => {
	test("the process resolves a throwaway configuration root", () => {
		const resolved = resolveConfigRoot();
		const configured = process.env.AGENTIC_CODING_CONFIG_DIR;
		if (!configured) throw new Error("the preload left no configuration root");
		expect(resolved).toBe(path.resolve(configured));
		expect(fs.existsSync(resolved)).toBe(true);
		// The one thing that must never happen: the real directory selected.
		const real = realConfigRoot(realHome());
		expect(inside(real, fs.realpathSync(resolved))).toBe(false);
	});

	test("every workflow location resolves inside the isolated configuration root", () => {
		const configured = fs.realpathSync(resolveConfigRoot());
		const roots = [configured, path.resolve(resolveConfigRoot())];
		const locations: Record<string, string> = {
			"wiki root": wikiRoot(),
			"default wiki root": defaultWikiRoot(),
			"workflow data root": wikiWorkflowDataRoot(),
			"target registry": targetRegistryDirectory(),
			"wiki store": canonicalStorePath(WIKI_WORKFLOW_TARGET),
		};
		for (const [name, location] of Object.entries(locations)) {
			const message = `${name} (${location}) resolves inside ${configured}`;
			expect([message, roots.some((root) => inside(root, location))]).toEqual([
				message,
				true,
			]);
		}
	});

	test("the default wiki root follows the configuration root", () => {
		// The regression this file exists for: with no `HERDR_WIKI_DIR` and no
		// configured `wiki.root`, both the bundle and the workflow data root it
		// parents must come from the configuration root, not from a literal
		// `~/.config/agentic-coding`.
		const previous = process.env.HERDR_WIKI_DIR;
		delete process.env.HERDR_WIKI_DIR;
		try {
			expect(defaultWikiRoot()).toBe(
				path.join(path.resolve(resolveConfigRoot()), "wiki"),
			);
			expect(wikiRoot()).toBe(path.resolve(defaultWikiRoot()));
			expect(wikiWorkflowDataRoot()).toBe(
				path.join(
					fs.realpathSync(resolveConfigRoot()),
					".agentic-coding-workflow",
				),
			);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previous;
		}
	});

	test("a wiki snapshot lands under the isolated wiki data root", () => {
		// `workflowSnapshotBase()` — the base a wiki write copies its snapshot into —
		// is the wiki root's parent directory plus `.agentic-coding-workflow` for a
		// wiki or research target, and the *current directory* otherwise. That is the
		// whole reason the wiki root must follow the configuration root: with the
		// literal default, a snapshot taken in a test landed in the developer's real
		// configuration directory.
		const previousTarget = process.env.HERDR_WORKFLOW_TARGET;
		const previousChange = process.env.HERDR_CHANGE_ID;
		const concept = {
			type: "concept",
			title: "Isolation snapshot",
			description: "written by the isolation guard",
			sources: [{ id: "spec", resource: "docs/test-isolation.md" }],
			body: "The snapshot of this concept must stay in the sandbox.[^spec]",
		};
		try {
			// The first write has no change id to snap under; the second one has, so
			// there is an existing concept to copy.
			delete process.env.HERDR_CHANGE_ID;
			writeConcept("isolation/snapshot", concept);
			process.env.HERDR_WORKFLOW_TARGET = WIKI_WORKFLOW_TARGET;
			process.env.HERDR_CHANGE_ID = "isolation-snapshot";
			writeConcept("isolation/snapshot", concept);
			// The snapshot root is `<base>/.herdr-workflow/<changeId>/wiki-snapshot`,
			// and `base` is `workflowSnapshotBase()` — the wiki root's parent
			// directory plus `.agentic-coding-workflow`. Both halves of that path are
			// the configuration root's, which is what this asserts.
			const snapshotBase = path.join(
				path.dirname(wikiRoot()),
				".agentic-coding-workflow",
			);
			expect(
				fs.existsSync(
					path.join(
						snapshotBase,
						".herdr-workflow",
						"isolation-snapshot",
						"wiki-snapshot",
						"isolation",
						"snapshot.md",
					),
				),
			).toBe(true);
			// And the base is the isolated configuration root's, never a home
			// directory: `wikiWorkflowDataRoot()` names the same directory.
			expect(
				inside(
					fs.realpathSync(resolveConfigRoot()),
					fs.realpathSync(snapshotBase),
				),
			).toBe(true);
		} finally {
			if (previousTarget === undefined)
				delete process.env.HERDR_WORKFLOW_TARGET;
			else process.env.HERDR_WORKFLOW_TARGET = previousTarget;
			if (previousChange === undefined) delete process.env.HERDR_CHANGE_ID;
			else process.env.HERDR_CHANGE_ID = previousChange;
		}
	});

	test("an explicit wiki root still wins over the default", () => {
		const configRoot = tempDirectory("isolation-explicit-root-");
		const bundle = tempDirectory("isolation-explicit-wiki-");
		const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
		const previousWiki = process.env.HERDR_WIKI_DIR;
		fs.writeFileSync(
			path.join(configRoot, "config.json"),
			`${JSON.stringify({ wiki: { root: bundle } })}\n`,
		);
		process.env.AGENTIC_CODING_CONFIG_DIR = configRoot;
		// The environment still outranks a configured root; this case is about the
		// configuration, so it steps aside for the duration.
		delete process.env.HERDR_WIKI_DIR;
		try {
			expect(wikiRoot()).toBe(path.resolve(bundle));
		} finally {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
			if (previousWiki === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWiki;
			fs.rmSync(configRoot, { recursive: true, force: true });
			fs.rmSync(bundle, { recursive: true, force: true });
		}
	});

	test("a recorded target lands in the isolated registry", () => {
		const target = tempDirectory("isolation-recorded-target-");
		const registry = targetRegistryDirectory();
		recordWorkflowTarget(target);
		const markers = fs
			.readdirSync(registry)
			.filter((name) => name.endsWith(".json"));
		const recorded = markers
			.map(
				(name) =>
					JSON.parse(fs.readFileSync(path.join(registry, name), "utf8")) as {
						target?: unknown;
					},
			)
			.map((marker) => marker.target);
		fs.rmSync(target, { recursive: true, force: true });
		// The registry itself is deleted with the sandbox; only the recorded
		// target is asserted, never the marker file count of the developer's own.
		expect(recorded).toContain(target);
	});

	test("the built-in configuration hard-codes no location", () => {
		// A fallback path written into `DEFAULT_CONFIG` is resolved for *both* the
		// configuration it belongs to and the one a test is handed, which is how
		// the wiki bundle escaped its configuration root. Its default is a function
		// of the configuration root (`defaultWikiRoot()`), so the key must stay
		// absent.
		expect(DEFAULT_CONFIG.wiki?.root).toBeUndefined();
	});
});

describe("the real-configuration guard", () => {
	test("counting the registry never creates it", () => {
		const configRoot = tempDirectory("guard-untouched-");
		try {
			expect(snapshotRealConfig(configRoot).targetMarkers).toBeNull();
			expect(
				fs.existsSync(path.join(configRoot, ".agentic-coding-workflow")),
			).toBe(false);
		} finally {
			fs.rmSync(configRoot, { recursive: true, force: true });
		}
	});

	test("a grown registry fails loudly, a shrink or a deletion does not", () => {
		const configRoot = tempDirectory("guard-grown-");
		try {
			const registry = registryInside(configRoot);
			fs.mkdirSync(registry, { recursive: true });
			fs.writeFileSync(path.join(registry, "one.json"), '{"target":"/work"}\n');
			const before = snapshotRealConfig(configRoot);
			expect(before.targetMarkers).toBe(1);
			expect(() => assertRealConfigUntouched(before, before)).not.toThrow();
			expect(() =>
				assertRealConfigUntouched(before, {
					configRoot,
					targetMarkers: 0,
				}),
			).not.toThrow();
			// A developer who removes their own configuration mid-run must not fail
			// a suite that did nothing wrong.
			expect(() =>
				assertRealConfigUntouched(before, {
					configRoot,
					targetMarkers: null,
				}),
			).not.toThrow();
			expect(() =>
				assertRealConfigUntouched(before, {
					configRoot,
					targetMarkers: 2,
				}),
			).toThrow("test isolation failed");
		} finally {
			fs.rmSync(configRoot, { recursive: true, force: true });
		}
	});
});
