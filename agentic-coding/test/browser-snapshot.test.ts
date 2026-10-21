// The AI snapshot adapter (`improve-browser-agent-loop`, task 1.1).
//
// The adapter is the only place that turns a Playwright page or locator into
// bounded snapshot text. These tests use a structural source instead of a real
// page, so the read options and the caps are testable without Chromium.
import { describe, expect, test } from "bun:test";
import {
	type AriaSnapshotSource,
	captureLocatorSnapshot,
	capturePageSnapshot,
	diffSnapshotNodes,
	findSnapshotNodes,
	formatSnapshotObservation,
	isRef,
	parseSnapshotNodes,
	SNAPSHOT_DEFAULT_CHARS,
	SNAPSHOT_DEFAULT_DEPTH,
	SNAPSHOT_MAX_CHARS,
	SNAPSHOT_MAX_DEPTH,
	SNAPSHOT_OBSERVATION_CHARS,
	SNAPSHOT_OBSERVATION_LINES,
	snapshotRefCount,
	snapshotRefs,
} from "../src/server/browser/snapshot.ts";

interface SnapshotCall {
	readonly mode?: "ai" | "default";
	readonly depth?: number;
	readonly timeout?: number;
}

function source(text: string, calls: SnapshotCall[] = []): AriaSnapshotSource {
	return {
		ariaSnapshot: async (options) => {
			calls.push(options);
			return text;
		},
	};
}

describe("AI snapshot adapter", () => {
	test("reads the page with the default depth and character cap", async () => {
		const calls: SnapshotCall[] = [];
		const text = [
			'- heading "Customers" [ref=e1]',
			'- textbox "Search" [ref=e2]',
		].join("\n");
		const result = await capturePageSnapshot(source(text, calls), {
			timeoutMs: 4_000,
		});

		expect(calls).toEqual([
			{ mode: "ai", depth: SNAPSHOT_DEFAULT_DEPTH, timeout: 4_000 },
		]);
		expect(result).toEqual({
			text,
			chars: text.length,
			truncated: false,
			depth: SNAPSHOT_DEFAULT_DEPTH,
			maxChars: SNAPSHOT_DEFAULT_CHARS,
		});
	});

	test("clamps depth and the character cap to the public bounds", async () => {
		const calls: SnapshotCall[] = [];
		const text = '- form\n  - button "Save" [ref=e1]';
		const result = await capturePageSnapshot(source(text, calls), {
			depth: SNAPSHOT_MAX_DEPTH + 50,
			maxChars: SNAPSHOT_MAX_CHARS + 50,
		});

		expect(calls).toEqual([{ mode: "ai", depth: SNAPSHOT_MAX_DEPTH }]);
		expect(result.depth).toBe(SNAPSHOT_MAX_DEPTH);
		expect(result.maxChars).toBe(SNAPSHOT_MAX_CHARS);
	});

	test("reads a locator subtree through the same AI form", async () => {
		const calls: SnapshotCall[] = [];
		const text = [
			'- form "Address" [ref=e3]',
			'  - textbox "Street" [ref=e4]',
		].join("\n");
		const result = await captureLocatorSnapshot(source(text, calls), {
			depth: 8,
			maxChars: 500,
		});

		expect(calls).toEqual([{ mode: "ai", depth: 8 }]);
		expect(result.text).toBe(text);
		expect(result.chars).toBe(text.length);
		expect(result.truncated).toBe(false);
	});

	test("truncates at a line boundary and reports the returned length", async () => {
		const text = [
			'- heading "Customers" [ref=e1]',
			'- button "Save" [ref=e2]',
			'- button "Delete" [ref=e3]',
			'- link "Home" [ref=e4]',
		].join("\n");
		const result = await capturePageSnapshot(source(text), {
			maxChars: 65,
		});

		expect(result.truncated).toBe(true);
		expect(result.text).toBe(
			['- heading "Customers" [ref=e1]', '- button "Save" [ref=e2]'].join("\n"),
		);
		expect(result.text.endsWith("\n")).toBe(false);
		expect(result.chars).toBe(result.text.length);
		expect(result.chars).toBeLessThanOrEqual(65);
	});

	test("a single overlong line is still bounded", async () => {
		const text = `- text "${"x".repeat(100)}" [ref=e1]`;
		const result = await capturePageSnapshot(source(text), { maxChars: 30 });

		expect(result.truncated).toBe(true);
		expect(result.text).toBe(text.slice(0, 30));
		expect(result.chars).toBe(30);
	});

	test("a runtime without the public AI API fails instead of falling back", async () => {
		const unsupported = {} as unknown as AriaSnapshotSource;
		await expect(capturePageSnapshot(unsupported)).rejects.toMatchObject({
			code: "browser-snapshot-unsupported",
			status: 501,
		});
	});
});

describe("AI snapshot refs", () => {
	test("parses element and frame-prefixed refs in order without duplicates", () => {
		const text = [
			'- heading "Customers" [ref=e1]',
			'- iframe "Payment" [ref=f1e2]',
			'  - textbox "Card" [ref=f1e3]',
			'- iframe "Nested" [ref=f2e4]',
			'  - button "Save" [ref=f2f3e5]',
			'- button "Save" [ref=e1]',
		].join("\n");

		expect(snapshotRefs(text)).toEqual([
			"e1",
			"f1e2",
			"f1e3",
			"f2e4",
			"f2f3e5",
		]);
		expect(snapshotRefCount(text)).toBe(5);
	});

	test("accepts only well-formed refs", () => {
		for (const ref of ["e0", "e17", "f1e3", "f12e4", "f2f3e5"])
			expect(isRef(ref)).toBe(true);
		for (const ref of [
			"e",
			"f1",
			"f1e",
			"e1f2",
			"f1e3x",
			"f1e3 ",
			"data-ac-ref",
		])
			expect(isRef(ref)).toBe(false);
	});
});

describe("snapshot node map", () => {
	const text = [
		"- generic [ref=e1]:",
		'  - heading "Customers" [level=1] [ref=e2]',
		'  - textbox "Search" [ref=e3]: Ada',
		'  - checkbox "Active" [checked] [ref=e4]',
		'  - button "Save" [disabled] [ref=e5]',
		'  - iframe "Payment" [ref=f1e6]:',
		'    - textbox "Card" [ref=f1e7]',
	].join("\n");

	test("extracts role, name, ref, text and state flags at their depth", () => {
		const nodes = parseSnapshotNodes(text);
		expect(nodes).toHaveLength(7);
		expect(nodes[1]).toMatchObject({
			role: "heading",
			name: "Customers",
			ref: "e2",
			depth: 1,
		});
		expect(nodes[2]).toMatchObject({
			role: "textbox",
			name: "Search",
			ref: "e3",
			text: "Ada",
			depth: 1,
		});
		expect(nodes[3]).toMatchObject({
			role: "checkbox",
			name: "Active",
			ref: "e4",
			checked: true,
		});
		expect(nodes[4]).toMatchObject({
			role: "button",
			name: "Save",
			ref: "e5",
			disabled: true,
		});
		expect(nodes[6]).toMatchObject({
			role: "textbox",
			name: "Card",
			ref: "f1e7",
			depth: 2,
		});
	});
});

describe("snapshot diff", () => {
	test("reports additions, removals and changes by ref", () => {
		const before = parseSnapshotNodes(
			[
				'- heading "Customers" [ref=e1]',
				'- button "Save" [ref=e2]',
				'- text "Name: Ada" [ref=e3]',
			].join("\n"),
		);
		const after = parseSnapshotNodes(
			[
				'- heading "Customers" [ref=e1]',
				'- button "Save" [ref=e9]',
				'- text "Name: Grace" [ref=e3]',
				'- button "Delete" [ref=e4]',
			].join("\n"),
		);
		const delta = diffSnapshotNodes(before, after);
		expect(delta.totals).toEqual({ added: 1, removed: 0, changed: 1 });
		expect(delta.added.map((entry) => entry.ref)).toEqual(["e4"]);
		expect(delta.changed).toEqual([
			{ ref: "e3", role: "text", name: "Name: Grace" },
		]);
	});

	test("treats a ref-only re-render as unchanged and keeps real changes", () => {
		const before = parseSnapshotNodes(
			['- button "Save" [ref=e1]', '- text "Draft" [ref=e2]'].join("\n"),
		);
		const after = parseSnapshotNodes(
			['- button "Save" [ref=e8]', '- text "Saved" [ref=e9]'].join("\n"),
		);
		const delta = diffSnapshotNodes(before, after);
		expect(delta.totals).toEqual({ added: 0, removed: 0, changed: 1 });
		expect(delta.changed[0]?.ref).toBe("e9");
	});

	test("caps each category at 50 entries and reports truncation", () => {
		const lines = Array.from(
			{ length: 80 },
			(_, index) => `- button "Button ${index}" [ref=e${index}]`,
		);
		const delta = diffSnapshotNodes([], parseSnapshotNodes(lines.join("\n")));
		expect(delta.added).toHaveLength(50);
		expect(delta.totals.added).toBe(80);
		expect(delta.truncated).toBe(true);
	});
});

describe("action observation formatter", () => {
	test("summarises the delta and only the first 20 changed lines", () => {
		const after = parseSnapshotNodes(
			Array.from(
				{ length: 25 },
				(_, index) => `- button "Button ${index}" [ref=e${index}]`,
			).join("\n"),
		);
		const delta = diffSnapshotNodes([], after);
		const observation = formatSnapshotObservation({
			url: "https://app.test/customers",
			title: "Customers",
			delta,
		});
		const lines = observation.split("\n");
		expect(lines[0]).toBe("url: https://app.test/customers");
		expect(lines[1]).toBe("title: Customers");
		expect(lines[2]).toBe("changed: +25 -0 ~0");
		expect(lines.slice(3, 3 + SNAPSHOT_OBSERVATION_LINES)).toHaveLength(
			SNAPSHOT_OBSERVATION_LINES,
		);
		expect(observation).toContain("delta truncated");
	});

	test("caps the text at the observation budget and marks a navigation", () => {
		const after = parseSnapshotNodes(
			Array.from(
				{ length: 20 },
				(_, index) => `- text "${"x".repeat(500)} ${index}" [ref=e${index}]`,
			).join("\n"),
		);
		const delta = diffSnapshotNodes([], after);
		const observation = formatSnapshotObservation({
			url: "https://app.test/",
			delta,
		});
		expect(observation.length).toBeLessThanOrEqual(
			SNAPSHOT_OBSERVATION_CHARS + 2,
		);
		const navigation = formatSnapshotObservation({
			url: "https://app.test/next",
			navigation: true,
			snapshotRequired: true,
		});
		expect(navigation).toContain("navigated to a new document");
		expect(navigation).toContain("take a browser_snapshot");
	});
});

describe("find", () => {
	test("filters by role/name/text and bounds the result", () => {
		const nodes = parseSnapshotNodes(
			[
				'- heading "Customers" [ref=e1]',
				'- button "Save customer" [ref=e2]',
				'- button "Save draft" [ref=e3]',
				'- link "Customers" [ref=e4]',
			].join("\n"),
		);
		expect(
			findSnapshotNodes(nodes, {
				query: "save",
				role: "button",
				limit: 1,
			}),
		).toMatchObject({
			total: 2,
			truncated: true,
			matches: [{ ref: "e2", role: "button" }],
		});
		expect(
			findSnapshotNodes(nodes, {
				query: "customers",
				name: "customers",
				limit: 20,
			}),
		).toMatchObject({ total: 2, truncated: false });
		expect(
			findSnapshotNodes(nodes, { query: "missing", limit: 20 }),
		).toMatchObject({ total: 0, truncated: false, matches: [] });
	});
});
