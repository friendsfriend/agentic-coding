// The Evidence panel's data layer (add-dashboard-evidence-panel, task 1.1):
// the manifest and one entry's bytes are read through the gateway port, and a
// workflow event drops both so the next read is authoritative instead of served
// from a stale cache.
import { afterEach, expect, test } from "bun:test";
import type {
	EventEnvelope,
	ObservationRequest,
} from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import {
	EVIDENCE_TEXT_MAX_CHARS,
	EVIDENCE_TEXT_WINDOW_BYTES,
	loadEvidence,
	loadEvidenceFile,
	loadEvidenceText,
} from "../../src/tui/data/evidence.ts";
import {
	cache,
	clearGateway,
	configureGateway,
} from "../../src/tui/data/index.ts";

afterEach(() => clearGateway());

/** One entry per read, so a re-read is visible in what the manifest holds. */
function manifest(read: number) {
	return {
		workflowId: "wf-1",
		entries: Array.from({ length: read }, (_, index) => ({
			id: `01JENTRY00000000000000000${index}`,
			kind: "screenshot" as const,
			file: `01JENTRY00000000000000000${index}.png`,
			caption: `shot ${index}`,
			createdAt: "2026-01-01T12:04:05.000Z",
		})),
		bytes: 0,
		quotaBytes: 1024,
	};
}

test("the manifest is read through the evidence observation for the workflow", async () => {
	let observes = 0;
	configureGateway({
		observe: async (observation: ObservationRequest) => {
			if (observation.kind !== "evidence") throw new Error("unexpected read");
			expect(observation.repo).toBe("/repo");
			expect(observation.workflowId).toBe("wf-1");
			expect(observation.requestId).toBeUndefined();
			observes += 1;
			return manifest(observes);
		},
	} as unknown as DashboardGateway);

	expect((await loadEvidence("/repo", "wf-1"))?.entries).toHaveLength(1);
	// A plain read is cached: the panel refresh loop does not re-read per frame.
	await loadEvidence("/repo", "wf-1");
	expect(observes).toBe(1);

	// A forced read is what a dashboard refresh issues.
	expect(
		(await loadEvidence("/repo", "wf-1", undefined, { refresh: true }))
			?.entries,
	).toHaveLength(2);
	expect(observes).toBe(2);
});

test("one entry's bytes are read through the gateway file read", async () => {
	const files: string[] = [];
	configureGateway({
		evidenceFile: async (workflowId: string, id: string) => {
			files.push(`${workflowId}/${id}`);
			return new Uint8Array([1, 2, 3]);
		},
	} as unknown as DashboardGateway);

	expect(await loadEvidenceFile("/repo", "wf-1", "01JENTRY")).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	await loadEvidenceFile("/repo", "wf-1", "01JENTRY");
	expect(files).toEqual(["wf-1/01JENTRY"]);
});

test("a workflow event drops the manifest but keeps the immutable file bytes", async () => {
	let observes = 0;
	let files = 0;
	configureGateway({
		observe: async () => {
			observes += 1;
			return manifest(observes);
		},
		evidenceFile: async () => {
			files += 1;
			return new Uint8Array([7]);
		},
	} as unknown as DashboardGateway);

	await loadEvidence("/repo", "wf-1");
	await loadEvidenceFile("/repo", "wf-1", "01JENTRY");
	expect(observes).toBe(1);
	expect(files).toBe(1);

	const event: EventEnvelope = {
		instance: "test",
		sequence: 1,
		domain: "workflow",
		kind: "workflow.handoff",
		resource: "/repo",
		at: "2026-01-01T12:04:05.000Z",
		payload: {},
	};
	cache.applyEvent(event);

	// The manifest is dropped: a workflow event may have added an entry.
	expect((await loadEvidence("/repo", "wf-1"))?.entries).toHaveLength(2);
	expect(observes).toBe(2);
	// The stored bytes are not: a file is ULID-named and never rewritten, so only
	// a full invalidation can outdate it.
	expect(await loadEvidenceFile("/repo", "wf-1", "01JENTRY")).toEqual(
		new Uint8Array([7]),
	);
	expect(files).toBe(1);

	// A gap or a cleared cache is that full invalidation, and re-reads them.
	cache.markStale();
	expect(await loadEvidenceFile("/repo", "wf-1", "01JENTRY")).toEqual(
		new Uint8Array([7]),
	);
	expect(files).toBe(2);
});

test("an event for another repository leaves this workflow's evidence cached", async () => {
	let observes = 0;
	configureGateway({
		observe: async () => {
			observes += 1;
			return manifest(observes);
		},
	} as unknown as DashboardGateway);

	await loadEvidence("/repo", "wf-1");
	cache.applyEvent({
		instance: "test",
		sequence: 2,
		domain: "workflow",
		kind: "workflow.handoff",
		resource: "/other",
		at: "2026-01-01T12:04:05.000Z",
		payload: {},
	});

	expect((await loadEvidence("/repo", "wf-1"))?.entries).toHaveLength(1);
	expect(observes).toBe(1);
});

test("a report is decoded from the same immutable bytes, and a missing file is absent", async () => {
	const answers = new Map<string, Uint8Array | undefined>([
		[
			"01JREPORT",
			new TextEncoder().encode("# Run report\n\nThe cart was empty.\n"),
		],
		["01JMISSING", undefined],
	]);
	const files: string[] = [];
	configureGateway({
		evidenceFile: async (_workflowId: string, id: string) => {
			files.push(id);
			return answers.get(id);
		},
	} as unknown as DashboardGateway);

	expect(await loadEvidenceText("/repo", "wf-1", "01JREPORT")).toBe(
		"# Run report\n\nThe cart was empty.\n",
	);
	// The report comes from the entry-bytes key, so re-opening it is a cache hit:
	// a report's bytes are immutable once written.
	expect(await loadEvidenceText("/repo", "wf-1", "01JREPORT")).toBe(
		"# Run report\n\nThe cart was empty.\n",
	);
	expect(files).toEqual(["01JREPORT"]);

	// A file the gateway answers as gone is `undefined`, which the subview reports
	// as an absent report rather than an empty one.
	expect(await loadEvidenceText("/repo", "wf-1", "01JMISSING")).toBeUndefined();
});

test("a report longer than the bound is truncated instead of rendered whole", async () => {
	configureGateway({
		evidenceFile: async () =>
			new TextEncoder().encode("x".repeat(EVIDENCE_TEXT_MAX_CHARS + 500)),
	} as unknown as DashboardGateway);

	const text = await loadEvidenceText("/repo", "wf-1", "01JLONG");
	expect(text).toHaveLength(EVIDENCE_TEXT_MAX_CHARS);
});

test("a report's bytes that are not UTF-8 decode without throwing", async () => {
	// The store refuses a non-text report, but a manifest written by another
	// revision could still name one: the read answers text rather than failing the
	// page on a decoder error.
	configureGateway({
		evidenceFile: async () => new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]),
	} as unknown as DashboardGateway);

	const text = await loadEvidenceText("/repo", "wf-1", "01JBINARY");
	expect(text?.startsWith("# ")).toBe(true);
	expect(text).toContain("\n");
});

test("a report's decode is bounded before the text bound is applied", async () => {
	// The visible outcome (a long report is cut to `EVIDENCE_TEXT_MAX_CHARS`) is
	// satisfied by decoding the whole file and then slicing, so this asserts what
	// the decoder was handed instead: a multi-megabyte report costs one window.
	const decode = TextDecoder.prototype.decode;
	let decodedBytes = -1;
	TextDecoder.prototype.decode = function (
		this: TextDecoder,
		input?: AllowSharedBufferSource,
		options?: TextDecodeOptions,
	) {
		decodedBytes =
			input instanceof Uint8Array ? input.byteLength : (input?.byteLength ?? 0);
		return decode.call(this, input, options);
	};
	try {
		configureGateway({
			evidenceFile: async () =>
				new Uint8Array(EVIDENCE_TEXT_WINDOW_BYTES + 4_000_000),
		} as unknown as DashboardGateway);
		expect(
			await loadEvidenceText("/repo", "wf-1", "01JHUGEWINDOW"),
		).toHaveLength(EVIDENCE_TEXT_MAX_CHARS);
		expect(decodedBytes).toBe(EVIDENCE_TEXT_WINDOW_BYTES);
	} finally {
		TextDecoder.prototype.decode = decode;
	}
});
