// The stage step journal and the flow page (`add-stage-flow-evidence`,
// tasks 1.1/1.2/1.3).
//
// The journal is one JSONL file beside the manifest: the server owns the
// sequence number, the time and every fact it already knows, redaction happens
// before the bytes land, a step that names evidence the manifest does not hold is
// refused rather than written, and the file is capped instead of grown. The flow
// page is rendered from the journal and the manifest alone, so the same two
// inputs always produce the same bytes and the page needs no network and no
// binary dependency to be read.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendStageJournalEntry,
	backfillStageJournalVideo,
	DEFAULT_STAGE_JOURNAL_LIMIT,
	hasStageJournal,
	journalSummary,
	MAX_STAGE_JOURNAL_ENTRIES,
	readStageJournal,
	renderStageFlowPage,
	STAGE_FLOW_FILE,
	STAGE_JOURNAL_FILE,
	writeStageFlowPage,
} from "../src/server/evidence/journal.ts";
import {
	attachEvidence,
	EVIDENCE_FILE_MAX_BYTES,
	EvidenceError,
	listEvidence,
} from "../src/server/evidence/store.ts";
import {
	type WorkflowEvidenceScope,
	workflowEvidenceScope,
} from "../src/workflow/runtime/evidence-store.ts";

const WORKFLOW_ID = "wf-flow";
const SECRET = "journal-secret-sentinel-4f21";
const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);

/** One repository-backed workflow, plus a scratch directory to attach from. */
function fixture(): {
	readonly worktree: string;
	readonly scope: WorkflowEvidenceScope;
	write(name: string, content: Buffer): string;
} {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "stage-journal-"));
	const worktree = path.join(base, "repo");
	fs.mkdirSync(worktree, { recursive: true });
	return {
		worktree,
		scope: workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree }),
		write(name, content) {
			const file = path.join(worktree, "in", name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		},
	};
}

/** The redactor a route hands the writer: one that masks the configured secret,
 * exactly like the browser reply scrubber does. */
function redact(value: string): string {
	return value.split(SECRET).join("[redacted]");
}

describe("stage step journal", () => {
	test("a workflow that recorded no step has no journal and no flow page", async () => {
		const { scope } = fixture();
		expect(hasStageJournal(scope)).toBe(false);
		expect(readStageJournal(scope)).toEqual([]);
		expect(journalSummary(scope)).toEqual({
			workflowId: WORKFLOW_ID,
			entries: [],
		});
		// Rendering rather than writing: no journal means no page, so the panel's
		// "open flow" action has nothing to offer.
		expect(await writeStageFlowPage(scope)).toBeUndefined();
	});

	test("the server owns the sequence number, the time and every known fact", async () => {
		const { scope } = fixture();
		const first = await appendStageJournalEntry(scope, {
			session: "default",
			app: "web",
			role: "clerk",
			url: "https://grid-int.example.test/dash",
			label: "open the cart",
			expected: "cart is empty",
			observed: "one item",
			captures: { total: "0.00 EUR" },
			now: () => new Date("2026-01-01T10:00:00.000Z"),
		});
		expect(first.seq).toBe(1);
		expect(first.at).toBe("2026-01-01T10:00:00.000Z");
		expect(first.session).toBe("default");
		expect(first.app).toBe("web");
		expect(first.role).toBe("clerk");
		expect(first.expected).toBe("cart is empty");
		expect(first.captures).toEqual({ total: "0.00 EUR" });

		const second = await appendStageJournalEntry(scope, {
			label: "checkout",
			now: () => new Date("2026-01-01T10:00:05.000Z"),
		});
		expect(second.seq).toBe(2);

		// The file is one JSONL line per step, in write order, read back the same.
		const file = path.join(scope.root, STAGE_JOURNAL_FILE);
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(readStageJournal(scope).map((entry) => entry.seq)).toEqual([1, 2]);
		expect(hasStageJournal(scope)).toBe(true);
		// Only the owner can read it: a step may quote a page.
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	test("redaction runs before the bytes land, for the label and the captures", async () => {
		const { scope } = fixture();
		await appendStageJournalEntry(
			scope,
			{
				label: `submitted the form with ${SECRET}`,
				observed: `response carried ${SECRET}`,
				captures: { [`token-${SECRET}`]: SECRET },
			},
			redact,
		);
		const file = path.join(scope.root, STAGE_JOURNAL_FILE);
		const text = fs.readFileSync(file, "utf8");
		expect(text).not.toContain(SECRET);
		expect(text).toContain("[redacted]");
		// The flow page is rendered from the journal, so it is scrubbed too.
		const page = await writeStageFlowPage(scope, redact);
		expect(page).toBe(STAGE_FLOW_FILE);
		const html = fs.readFileSync(
			path.join(scope.root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(html).not.toContain(SECRET);
	});

	test("a step that names evidence the manifest does not hold is refused", async () => {
		const { scope } = fixture();
		const refusal = await appendStageJournalEntry(scope, {
			label: "look at the screenshot",
			evidence: ["01J0NOPE0000000000000000A"],
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(EvidenceError);
		expect((refusal as EvidenceError).code).toBe("evidence-missing");
		expect((refusal as EvidenceError).status).toBe(404);
		// Nothing was written: the journal still does not exist.
		expect(hasStageJournal(scope)).toBe(false);
	});

	test("a step references a real evidence id, and keeps it", async () => {
		const { scope, write } = fixture();
		const entry = await attachEvidence(scope, {
			path: write("shot.png", PNG),
			kind: "screenshot",
			caption: "empty cart",
		});
		const step = await appendStageJournalEntry(scope, {
			label: "the cart is empty",
			evidence: [entry.id, entry.id],
		});
		// Duplicates are collapsed: a page linking the same picture twice is noise.
		expect(step.evidence).toEqual([entry.id]);
	});

	test("the journal is capped at the evidence per-file limit rather than grown", async () => {
		const { scope } = fixture();
		// One step whose label nearly fills the cap, so the second is refused.
		const nearly = "x".repeat(EVIDENCE_FILE_MAX_BYTES - 200);
		await appendStageJournalEntry(scope, { label: nearly });
		const refusal = await appendStageJournalEntry(scope, {
			label: "y".repeat(400),
		}).catch((error: unknown) => error);
		expect((refusal as EvidenceError).code).toBe("stage-journal-full");
		expect((refusal as EvidenceError).status).toBe(409);
		// The step that was recorded is still there, untouched.
		expect(readStageJournal(scope)).toHaveLength(1);
	});

	test("a read answers the latest steps, bounded and optionally narrowed", async () => {
		const { scope } = fixture();
		for (let index = 1; index <= 3; index += 1)
			await appendStageJournalEntry(scope, {
				label: `step ${index}`,
				...(index === 2 ? { app: "mail", session: "second" } : {}),
			});
		const all = journalSummary(scope);
		expect(all.entries.map((entry) => entry.label)).toEqual([
			"step 1",
			"step 2",
			"step 3",
		]);
		expect(all.flowPage).toBe(STAGE_FLOW_FILE);
		expect(
			journalSummary(scope, { app: "mail" }).entries.map((e) => e.seq),
		).toEqual([2]);
		expect(
			journalSummary(scope, { session: "second" }).entries.map((e) => e.seq),
		).toEqual([2]);
		// The default bound is what a tool call without a limit gets, and the read
		// never answers more than the contract's maximum.
		expect(
			journalSummary(scope, { limit: 2 }).entries.map((e) => e.seq),
		).toEqual([2, 3]);
		expect(DEFAULT_STAGE_JOURNAL_LIMIT).toBeLessThanOrEqual(
			MAX_STAGE_JOURNAL_ENTRIES,
		);
	});

	test("a malformed line is skipped instead of making the journal unreadable", async () => {
		const { scope } = fixture();
		await appendStageJournalEntry(scope, { label: "first" });
		const file = path.join(scope.root, STAGE_JOURNAL_FILE);
		fs.appendFileSync(file, "{not json}\n\n");
		await appendStageJournalEntry(scope, { label: "second" });
		const entries = readStageJournal(scope);
		expect(entries.map((entry) => entry.label)).toEqual(["first", "second"]);
		// The sequence number continues from what was readable, not from the line
		// count.
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
	});
});

describe("stage flow page", () => {
	test("a kept recording and its steps render one section with seeking links", async () => {
		const { scope, write } = fixture();
		const video = await attachEvidence(scope, {
			path: write("run.webm", WEBM),
			kind: "video",
			caption: "checkout flow",
			segment: 1,
		});
		const poster = await attachEvidence(scope, {
			path: write("poster.png", PNG),
			kind: "screenshot",
			caption: "final frame",
			poster: undefined,
		});
		await appendStageJournalEntry(scope, {
			app: "web",
			role: "clerk",
			label: "open the cart",
			segment: 1,
			offsetMs: 1_500,
			evidence: [poster.id],
		});
		await appendStageJournalEntry(scope, {
			label: "checkout",
			segment: 1,
			offsetMs: 65_000,
		});
		// The stop back-fills the kept video's id onto the segment's steps.
		expect(
			await backfillStageJournalVideo(scope, { segment: 1, video: video.id }),
		).toBe(2);
		// A retried stop rewrites nothing.
		expect(
			await backfillStageJournalVideo(scope, { segment: 1, video: video.id }),
		).toBe(0);
		expect(readStageJournal(scope).map((entry) => entry.video)).toEqual([
			video.id,
			video.id,
		]);

		const page = await writeStageFlowPage(scope);
		expect(page).toBe(STAGE_FLOW_FILE);
		const html = fs.readFileSync(
			path.join(scope.root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(html).toContain("<h2>Segment 1</h2>");
		// The recording is linked by its relative file name, so the page works from
		// a file:// URL with no server behind it.
		expect(html).toContain(`src="${video.file}"`);
		expect(html).not.toContain("http://");
		expect(html).not.toContain("https://");
		// Each step seeks its own offset, in whole seconds.
		expect(html).toContain(`href="${video.file}#t=2"`);
		expect(html).toContain(`href="${video.file}#t=65"`);
		expect(html).toContain("00:02 open the cart");
		expect(html).toContain("01:05 checkout");
		expect(html).toContain("web / clerk");
		expect(html).toContain(`screenshot ${poster.id}: final frame`);
	});

	test("the same journal and manifest render the same bytes", async () => {
		const { scope, write } = fixture();
		const shot = await attachEvidence(scope, {
			path: write("shot.png", PNG),
			kind: "screenshot",
			caption: "empty cart",
		});
		await appendStageJournalEntry(scope, {
			label: "the cart is empty",
			evidence: [shot.id],
			offsetMs: 0,
		});
		const journal = readStageJournal(scope);
		const manifest = listEvidence(scope);
		expect(renderStageFlowPage(WORKFLOW_ID, journal, manifest)).toBe(
			renderStageFlowPage(WORKFLOW_ID, journal, manifest),
		);
		// A step without a recording is still shown, under its own heading.
		const html = renderStageFlowPage(WORKFLOW_ID, journal, manifest);
		expect(html).toContain("Steps without a recording");
		expect(html).toContain("the cart is empty");
	});

	test("markup in a step is escaped, so a page cannot inject into the flow", async () => {
		const { scope } = fixture();
		await appendStageJournalEntry(scope, {
			label: '<script>alert("x")</script>',
			observed: "'quoted' & <b>bold</b>",
		});
		// Nothing writes the page until it is asked for, so a step cannot leave a
		// stale page behind: the render is what produces it.
		expect(fs.existsSync(path.join(scope.root, STAGE_FLOW_FILE))).toBe(false);
		expect(await writeStageFlowPage(scope)).toBe(STAGE_FLOW_FILE);
		const page = fs.readFileSync(
			path.join(scope.root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(page).not.toContain("<script>");
		expect(page).toContain("&lt;script&gt;");
		expect(page).toContain("&#39;quoted&#39; &amp; &lt;b&gt;bold&lt;/b&gt;");
	});
});
