// The evidence store (`add-workflow-evidence-store`, tasks 1.1/1.2/1.3): the
// layout and manifest, the ids that make creation order lexical order, the
// kind/content checks, the caps that refuse rather than evict, and the path
// safety that keeps an attach inside the workflow's own roots.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	attachEvidence,
	EVIDENCE_FILE_MAX_BYTES,
	EVIDENCE_QUOTA_BYTES,
	EvidenceError,
	evidenceDirectoryNames,
	evidenceEntry,
	evidenceFilePath,
	evidenceId,
	listEvidence,
} from "../src/server/evidence/store.ts";
import {
	removeWorkflowEvidence,
	workflowEvidencePresent,
	workflowEvidenceScope,
} from "../src/workflow/runtime/evidence-store.ts";

const WORKFLOW_ID = "wf-alpha";

const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);
const MP4 = Buffer.from([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

/** One repository-backed workflow: its checkout is a directory of its own, so
 * the evidence root is `<checkout>/.herdr-workflow/evidence/<workflowId>`. */
function fixture(): {
	readonly worktree: string;
	readonly outside: string;
	readonly scope: ReturnType<typeof workflowEvidenceScope>;
	write(name: string, content: Buffer): string;
} {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-store-"));
	const worktree = path.join(base, "repo");
	const outside = path.join(base, "outside");
	fs.mkdirSync(worktree, { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	const scope = workflowEvidenceScope({ workflowId: WORKFLOW_ID, worktree });
	return {
		worktree,
		outside,
		scope,
		write(name, content) {
			const file = path.join(worktree, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
			return file;
		},
	};
}

function writtenManifest(scope: { root: string }): {
	version: number;
	workflowId: string;
	entries: Array<Record<string, unknown>>;
} {
	return JSON.parse(
		fs.readFileSync(path.join(scope.root, "manifest.json"), "utf8"),
	);
}

describe("evidence layout and manifest", () => {
	test("a screenshot is copied in, captioned and listed", async () => {
		const { scope, write, worktree } = fixture();
		const source = write("shot.png", PNG);
		const entry = await attachEvidence(scope, {
			path: source,
			kind: "screenshot",
			caption: "checkout button, empty cart",
			step: "core.implementation",
			role: "worker",
			app: "shop",
		});
		expect(entry.kind).toBe("screenshot");
		expect(entry.caption).toBe("checkout button, empty cart");
		expect(entry.step).toBe("core.implementation");
		expect(entry.role).toBe("worker");
		expect(entry.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(entry.file).toBe(`${entry.id}.png`);
		// The evidence lives under the workflow's own data directory, not in the
		// scratch path the agent happened to write to.
		expect(scope.root).toBe(
			path.join(worktree, ".herdr-workflow", "evidence", WORKFLOW_ID),
		);
		expect(fs.readFileSync(path.join(scope.root, entry.file))).toEqual(PNG);
		// Copy-in: the file the agent produced is still where it wrote it.
		expect(fs.existsSync(source)).toBe(true);
		const manifest = writtenManifest(scope);
		expect(manifest.workflowId).toBe(WORKFLOW_ID);
		expect(manifest.entries).toHaveLength(1);
		expect(manifest.entries[0]?.caption).toBe("checkout button, empty cart");
	});

	test("ids are time-ordered, so the manifest lists oldest first", async () => {
		const { scope, write } = fixture();
		const first = write("a.png", PNG);
		const second = write("b.png", PNG);
		const third = write("c.png", PNG);
		await attachEvidence(scope, {
			path: second,
			kind: "screenshot",
			caption: "second",
			now: () => new Date(1_000_000_200_000),
		});
		await attachEvidence(scope, {
			path: third,
			kind: "screenshot",
			caption: "third",
			now: () => new Date(1_000_000_300_000),
		});
		await attachEvidence(scope, {
			path: first,
			kind: "screenshot",
			caption: "first",
			now: () => new Date(1_000_000_100_000),
		});
		expect(listEvidence(scope).entries.map((entry) => entry.caption)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(evidenceId(1_000_000_100_000) < evidenceId(1_000_000_200_000)).toBe(
			true,
		);
	});

	test("evidence for one debug request is stored under its own directory", async () => {
		const { scope, write } = fixture();
		const source = write("trace.zip", ZIP);
		await attachEvidence(scope, {
			path: source,
			kind: "trace",
			caption: "playwright trace",
			requestId: "42",
		});
		const all = listEvidence(scope);
		expect(all.entries).toHaveLength(1);
		expect(all.entries[0]?.file.startsWith("req-42/")).toBe(true);
		expect(listEvidence(scope, { requestId: "42" }).entries).toHaveLength(1);
		expect(listEvidence(scope, { requestId: "other" }).entries).toHaveLength(0);
	});

	test("a workflow that never attached anything answers an empty manifest", () => {
		const { scope } = fixture();
		const manifest = listEvidence(scope);
		expect(manifest.entries).toEqual([]);
		expect(manifest.bytes).toBe(0);
		expect(manifest.quotaBytes).toBe(EVIDENCE_QUOTA_BYTES);
	});

	test("the manifest is replaced atomically", async () => {
		const { scope, write } = fixture();
		await attachEvidence(scope, {
			path: write("one.png", PNG),
			kind: "screenshot",
			caption: "one",
		});
		await attachEvidence(scope, {
			path: write("two.png", PNG),
			kind: "screenshot",
			caption: "two",
		});
		// One manifest, no temporary left behind by either write.
		expect(
			evidenceDirectoryNames(scope).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
		expect(writtenManifest(scope).entries).toHaveLength(2);
	});

	test("two attaches racing keep both entries", async () => {
		const { scope, write } = fixture();
		const sources = [
			write("a.png", PNG),
			write("b.png", PNG),
			write("c.png", PNG),
			write("d.png", PNG),
		];
		await Promise.all(
			sources.map((source, index) =>
				attachEvidence(scope, {
					path: source,
					kind: "screenshot",
					caption: `shot ${index}`,
				}),
			),
		);
		const entries = listEvidence(scope).entries;
		expect(entries).toHaveLength(4);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(4);
		for (const entry of entries)
			expect(fs.existsSync(path.join(scope.root, entry.file))).toBe(true);
	});

	test("a corrupt manifest is reported, never silently emptied", async () => {
		const { scope, write } = fixture();
		await attachEvidence(scope, {
			path: write("one.png", PNG),
			kind: "screenshot",
			caption: "one",
		});
		fs.writeFileSync(path.join(scope.root, "manifest.json"), "{ not json");
		expect(() => listEvidence(scope)).toThrow(EvidenceError);
	});
});

describe("kind and content checks", () => {
	test("a screenshot must really be an image", async () => {
		const { scope, write } = fixture();
		const text = write("shot.png", Buffer.from("this is not a png"));
		await expect(
			attachEvidence(scope, {
				path: text,
				kind: "screenshot",
				caption: "not really",
			}),
		).rejects.toMatchObject({ code: "evidence-kind" });
		expect(listEvidence(scope).entries).toEqual([]);
	});

	test("a PNG named .zip is refused rather than stored under a lying name", async () => {
		const { scope, write } = fixture();
		await expect(
			attachEvidence(scope, {
				path: write("trace.zip", PNG),
				kind: "trace",
				caption: "wrong bytes",
			}),
		).rejects.toMatchObject({ code: "evidence-kind" });
	});

	test("video, trace and script accept their own content", async () => {
		const { scope, write } = fixture();
		await attachEvidence(scope, {
			path: write("run.mp4", MP4),
			kind: "video",
			caption: "run",
		});
		await attachEvidence(scope, {
			path: write("run.webm", WEBM),
			kind: "video",
			caption: "run webm",
		});
		await attachEvidence(scope, {
			path: write("trace.zip", ZIP),
			kind: "trace",
			caption: "trace",
		});
		await attachEvidence(scope, {
			path: write(
				"repro.sh",
				Buffer.from("#!/bin/sh\ncurl -s localhost:3000\n"),
			),
			kind: "script",
			caption: "repro",
		});
		await attachEvidence(scope, {
			path: write(
				"server.log",
				Buffer.from("2026-01-01T00:00:00Z listen 3000\n"),
			),
			kind: "log",
			caption: "server log",
		});
		expect(listEvidence(scope).entries).toHaveLength(5);
	});

	test("binary content is not a script", async () => {
		const { scope, write } = fixture();
		await expect(
			attachEvidence(scope, {
				path: write("repro.sh", Buffer.from([0x01, 0x00, 0x02, 0x00])),
				kind: "script",
				caption: "binary",
			}),
		).rejects.toMatchObject({ code: "evidence-kind" });
	});

	test("a JPEG is stored unchanged and served by the file route's entry", async () => {
		const { scope, write } = fixture();
		const entry = await attachEvidence(scope, {
			path: write("shot.jpg", JPEG),
			kind: "screenshot",
			caption: "jpeg",
		});
		expect(entry.file.endsWith(".jpg")).toBe(true);
		expect(evidenceEntry(scope, entry.id)).toMatchObject({ id: entry.id });
		const file = evidenceFilePath(scope, entry);
		expect(file).toBe(path.join(scope.root, entry.file));
		expect(fs.readFileSync(file ?? "")).toEqual(JPEG);
	});
});

describe("caps refuse and never evict", () => {
	test("a file over its kind's per-file cap is refused with evidence-quota", async () => {
		const { scope, write } = fixture();
		const huge = write("huge.bin", Buffer.alloc(0));
		fs.truncateSync(huge, EVIDENCE_FILE_MAX_BYTES + 1);
		await expect(
			attachEvidence(scope, { path: huge, kind: "other", caption: "huge" }),
		).rejects.toMatchObject({ code: "evidence-quota", status: 409 });
		expect(fs.existsSync(path.join(scope.root, "manifest.json"))).toBe(false);
	});

	test("an attach that would exceed the workflow cap leaves every entry", async () => {
		const { scope, write } = fixture();
		await attachEvidence(scope, {
			path: write("kept.png", PNG),
			kind: "screenshot",
			caption: "kept",
		});
		// Fabricate a workflow that is one small file away from its cap: the
		// refusal path is the real one, without writing a gigabyte to disk.
		const manifest = writtenManifest(scope);
		manifest.entries.push({
			id: "01JCAAAAAAAAAAAAAAAAAAAAAA",
			kind: "video",
			file: "01JCAAAAAAAAAAAAAAAAAAAAAA.webm",
			caption: "already large",
			createdAt: "2026-01-01T00:00:00.000Z",
			bytes: EVIDENCE_QUOTA_BYTES - 8,
		});
		fs.writeFileSync(
			path.join(scope.root, "manifest.json"),
			JSON.stringify(manifest),
		);
		await expect(
			attachEvidence(scope, {
				path: write("next.png", PNG),
				kind: "screenshot",
				caption: "over the cap",
			}),
		).rejects.toMatchObject({ code: "evidence-quota", status: 409 });
		const after = listEvidence(scope);
		expect(after.entries.map((entry) => entry.caption)).toEqual([
			"kept",
			"already large",
		]);
		expect(after.bytes).toBe(EVIDENCE_QUOTA_BYTES - 8 + PNG.length);
	});

	test("a runaway manifest is refused rather than grown", async () => {
		const { scope, write } = fixture();
		await attachEvidence(scope, {
			path: write("kept.png", PNG),
			kind: "screenshot",
			caption: "kept",
		});
		const manifest = writtenManifest(scope);
		const fabricated = (count: number) => {
			for (let index = 0; index < count; index++)
				manifest.entries.push({
					id: `01JC${String(index).padStart(22, "A")}`,
					kind: "log",
					file: `01JC${String(index).padStart(22, "A")}.log`,
					caption: "",
					createdAt: "2026-01-01T00:00:00.000Z",
					bytes: 1,
				});
		};
		// At the bound an attach is refused; one past it the manifest itself is
		// reported as unreadable rather than loaded into memory.
		fabricated(9_999);
		fs.writeFileSync(
			path.join(scope.root, "manifest.json"),
			JSON.stringify(manifest),
		);
		await expect(
			attachEvidence(scope, {
				path: write("next.log", Buffer.from("one more line\n")),
				kind: "log",
				caption: "one too many",
			}),
		).rejects.toMatchObject({ code: "evidence-quota" });
		fabricated(1);
		fs.writeFileSync(
			path.join(scope.root, "manifest.json"),
			JSON.stringify(manifest),
		);
		expect(() => listEvidence(scope)).toThrow(EvidenceError);
	});

	test("pinned evidence is kept and does not fill the workflow's cap", async () => {
		const { scope, write } = fixture();
		const entry = await attachEvidence(scope, {
			path: write("kept.png", PNG),
			kind: "screenshot",
			caption: "pinned",
			pinned: true,
		});
		expect(entry.pinned).toBe(true);
		expect(listEvidence(scope).bytes).toBe(0);
	});
});

describe("attach path safety", () => {
	test("a file outside the checkout is refused", async () => {
		const { scope, outside } = fixture();
		const forbidden = path.join(outside, "secrets.txt");
		fs.writeFileSync(forbidden, "not yours");
		await expect(
			attachEvidence(scope, {
				path: forbidden,
				kind: "log",
				caption: "outside",
			}),
		).rejects.toMatchObject({ code: "evidence-path" });
		expect(listEvidence(scope).entries).toEqual([]);
	});

	test("a symlink pointing outside the checkout is refused", async () => {
		const { scope, write, outside, worktree } = fixture();
		const target = path.join(outside, "hosts.txt");
		fs.writeFileSync(target, "127.0.0.1 localhost\n");
		write("placeholder.txt", Buffer.from("x"));
		const symlink = path.join(worktree, "escape.txt");
		fs.symlinkSync(target, symlink);
		await expect(
			attachEvidence(scope, {
				path: symlink,
				kind: "log",
				caption: "symlinked out",
			}),
		).rejects.toMatchObject({ code: "evidence-path" });
	});

	test("a relative path is refused: the server never guesses a working directory", async () => {
		const { scope, write } = fixture();
		write("file.log", Buffer.from("hello\n"));
		await expect(
			attachEvidence(scope, {
				path: "file.log",
				kind: "log",
				caption: "relative",
			}),
		).rejects.toMatchObject({ code: "evidence-path" });
	});

	test("a directory is not evidence", async () => {
		const { scope, worktree } = fixture();
		fs.mkdirSync(path.join(worktree, "logs"));
		await expect(
			attachEvidence(scope, {
				path: path.join(worktree, "logs"),
				kind: "log",
				caption: "directory",
			}),
		).rejects.toMatchObject({ code: "evidence-path" });
	});

	test("a request id may never traverse", async () => {
		const { scope, write } = fixture();
		const source = write("file.log", Buffer.from("hello\n"));
		for (const requestId of ["../escape", "..", ".", "a/b", ""]) {
			await expect(
				attachEvidence(scope, {
					path: source,
					kind: "log",
					caption: "traversal",
					requestId,
				}),
			).rejects.toMatchObject({ code: "evidence-path" });
		}
	});
});

describe("evidence lifecycle", () => {
	test("evidence is removed with the workflow, idempotently", async () => {
		const { scope, write, worktree } = fixture();
		await attachEvidence(scope, {
			path: write("kept.png", PNG),
			kind: "screenshot",
			caption: "kept",
		});
		expect(workflowEvidencePresent({ workflowId: WORKFLOW_ID, worktree })).toBe(
			true,
		);
		expect(removeWorkflowEvidence({ workflowId: WORKFLOW_ID, worktree })).toBe(
			true,
		);
		expect(fs.existsSync(scope.root)).toBe(false);
		expect(workflowEvidencePresent({ workflowId: WORKFLOW_ID, worktree })).toBe(
			false,
		);
		expect(removeWorkflowEvidence({ workflowId: WORKFLOW_ID, worktree })).toBe(
			false,
		);
	});

	test("a wiki workflow keeps its evidence in the shared data root", () => {
		const scope = workflowEvidenceScope({
			workflowId: WORKFLOW_ID,
			worktree: "/tmp/wiki-worktree",
			definitionId: "wiki-comments",
		});
		expect(scope.dataRoot).not.toBe(
			path.join("/tmp/wiki-worktree", ".herdr-workflow"),
		);
		expect(scope.root.endsWith(path.join("evidence", WORKFLOW_ID))).toBe(true);
	});
});
