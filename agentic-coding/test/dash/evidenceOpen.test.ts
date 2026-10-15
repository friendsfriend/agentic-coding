// Opening one evidence file (add-dashboard-evidence-panel, task 2.3): the file
// the system opener receives, per platform, the address it is composed from, and
// the refusals that keep a server-supplied name away from a launcher.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { EvidenceEntry } from "../../src/contracts/environment.ts";
import {
	EvidencePathError,
	evidenceLocalPath,
	evidenceOpenRequest,
	openEvidenceExternally,
} from "../../src/tui/dash/evidence-open.ts";
import { systemOpenerSideApp } from "../../src/tui/shared/side-app.ts";
import { autoRemoveTempDirs, tempDir } from "../support/temp-dirs.ts";

// Every case here opens a file inside a real evidence root; the file-scoped
// sweep removes them when this file ends (test/support/temp-dirs.ts).
autoRemoveTempDirs();

const STATE = { workflowId: "wf-1", worktree: "/repo" };

function entry(
	overrides: Partial<EvidenceEntry> & { id: string },
): EvidenceEntry {
	return {
		kind: "screenshot",
		file: `${overrides.id}.png`,
		caption: "",
		createdAt: "2026-01-01T12:04:05.000Z",
		...overrides,
	};
}

/** A workflow whose evidence root is a real temporary directory. */
function fixture() {
	const worktree = tempDir("evidence-open-");
	return { worktree, state: { workflowId: "wf-1", worktree } };
}

/** Write the stored file one entry names, creating the evidence root. */
function store(worktree: string, file: string, content = "png"): string {
	const target = path.join(
		worktree,
		".herdr-workflow",
		"evidence",
		"wf-1",
		file,
	);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

test("the platform's own system opener receives the file", () => {
	expect(systemOpenerSideApp("/tmp/shots/one.png", "darwin")).toEqual({
		command: "open",
		args: ["/tmp/shots/one.png"],
		cwd: "/tmp/shots",
	});
	expect(systemOpenerSideApp("/tmp/shots/one.png", "linux")).toEqual({
		command: "xdg-open",
		args: ["/tmp/shots/one.png"],
		cwd: "/tmp/shots",
	});
	expect(systemOpenerSideApp("C:\\shots\\one.png", "win32")).toEqual({
		command: "cmd",
		args: ["/c", "start", "", "C:\\shots\\one.png"],
		cwd: "C:\\shots",
	});
	// A bare file name with no directory opens in the process's own directory.
	expect(systemOpenerSideApp("one.png", "linux").cwd).toBe(".");
});

test("an entry's address is the workflow's own evidence root", () => {
	expect(evidenceLocalPath(STATE, entry({ id: "01JSHOT" }))).toBe(
		"/repo/.herdr-workflow/evidence/wf-1/01JSHOT.png",
	);
	// A debug request's entry keeps its request directory.
	expect(
		evidenceLocalPath(
			STATE,
			entry({ id: "01JREQ", file: "req-dbg-1/01JREQ.png" }),
		),
	).toBe("/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/01JREQ.png");
});

test("the opener request is the stored file, for a screenshot and for a video", () => {
	const shot = evidenceOpenRequest(STATE, entry({ id: "01JSHOT" }));
	expect(shot.command).toBe(systemOpenerSideApp("x", process.platform).command);
	expect(shot.args).toEqual([
		"/repo/.herdr-workflow/evidence/wf-1/01JSHOT.png",
	]);
	expect(shot.cwd).toBe("/repo/.herdr-workflow/evidence/wf-1");

	const video = evidenceOpenRequest(
		STATE,
		entry({ id: "01JVIDEO", kind: "video", file: "req-dbg-1/01JVIDEO.webm" }),
	);
	expect(video.args).toEqual([
		"/repo/.herdr-workflow/evidence/wf-1/req-dbg-1/01JVIDEO.webm",
	]);
	expect(video.cwd).toBe("/repo/.herdr-workflow/evidence/wf-1/req-dbg-1");
});

test("opening hands the composed request to the launcher", async () => {
	const { worktree, state } = fixture();
	const screenshot = entry({ id: "01JSHOT" });
	const stored = store(worktree, screenshot.file);
	const launched: unknown[] = [];

	await openEvidenceExternally(state, screenshot, async (request) => {
		launched.push(request);
		return { mode: "local", status: 0 };
	});
	expect(launched).toEqual([evidenceOpenRequest(state, screenshot)]);
	expect(JSON.stringify(launched)).toContain(stored);

	// A video is handed to the opener the same way — it is never decoded inline.
	const video = entry({
		id: "01JVIDEO",
		kind: "video",
		file: "req-d/01JVIDEO.webm",
	});
	store(worktree, video.file, "webm");
	await openEvidenceExternally(state, video, async (request) => {
		launched.push(request);
		return { mode: "local", status: 0 };
	});
	expect(launched).toEqual([
		evidenceOpenRequest(state, screenshot),
		evidenceOpenRequest(state, video),
	]);
});

test("a file that is not on this machine is reported instead of launched", async () => {
	const { worktree, state } = fixture();
	const missing = entry({ id: "01JMISSING" });
	let launched = 0;
	await expect(
		openEvidenceExternally(state, missing, async () => {
			launched += 1;
			return { mode: "local", status: 0 };
		}),
	).rejects.toThrow(EvidencePathError);
	expect(launched).toBe(0);

	// Neither is a symlink planted where the stored file should be.
	const linked = entry({ id: "01JLINK" });
	const target = store(worktree, "elsewhere.png", "secret");
	fs.symlinkSync(
		target,
		path.join(worktree, ".herdr-workflow", "evidence", "wf-1", linked.file),
	);
	await expect(
		openEvidenceExternally(state, linked, async () => {
			launched += 1;
			return { mode: "local", status: 0 };
		}),
	).rejects.toThrow(EvidencePathError);
	expect(launched).toBe(0);
});

test("an opener that fails is reported instead of swallowed", async () => {
	const { worktree, state } = fixture();
	const shot = entry({ id: "01JFAIL" });
	store(worktree, shot.file);

	await expect(
		openEvidenceExternally(state, shot, async () => ({
			mode: "local",
			status: 3,
			stderr: "no handler for this file type\n",
		})),
	).rejects.toThrow(/no handler for this file type/);

	// A tmux window's own exit status belongs to the multiplexer, so it is not
	// this caller's failure to report.
	await openEvidenceExternally(state, shot, async () => ({ mode: "tmux" }));
});

test("a name that would leave the evidence root is refused", () => {
	for (const file of [
		"../../etc/passwd",
		"req-dbg/../../outside.png",
		"/etc/passwd",
		"req-dbg/nested/three.png",
		"..",
		"req-dbg/..",
	]) {
		expect(() =>
			evidenceLocalPath(STATE, entry({ id: "01JODD", file })),
		).toThrow(EvidencePathError);
	}
});
