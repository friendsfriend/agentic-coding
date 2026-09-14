// Canonical change-request shapes and diff parsing shared by the provider
// ports (`port-git-providers-and-ai-to-bun`, task 3.3). Field names and JSON
// tags match `server/pkg/changerequest` and the GitLab-shaped structs the Go
// GitHub client emitted, so the devenv CR client parses the Bun response
// unchanged.
import { createHash } from "node:crypto";
import type { Approvals, IssueAuthor } from "./issues.ts";

export type { Approvals };

export interface ChangeRequest {
	id: number;
	iid: number;
	title: string;
	description: string;
	source_branch: string;
	target_branch: string;
	default_branch?: string;
	state: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	author: IssueAuthor;
	head_pipeline?: { id: number; status: string; web_url: string };
	merge_status: string;
	detailed_merge_status: string;
	draft: boolean;
	work_in_progress: boolean;
	has_conflicts: boolean;
	blocking_discussions_resolved: boolean;
	rebase_in_progress: boolean;
	merge_error: string;
	approvals?: Approvals;
}

export interface ChangeRequestListResult {
	items: ChangeRequest[];
	totalCount: number;
	totalPages: number;
	currentPage: number;
	perPage: number;
}

export interface DiffLine {
	line_code: string;
	type: "new" | "old" | "match";
	old_line: number | null;
	new_line: number | null;
	text: string;
	rich_text: string;
}

export interface ChangeRequestChange {
	old_path: string;
	new_path: string;
	a_mode: string;
	b_mode: string;
	new_file: boolean;
	renamed_file: boolean;
	deleted_file: boolean;
	diff: string;
	lines_added: number;
	lines_deleted: number;
	diff_lines?: DiffLine[];
}

export interface Note {
	id: number;
	type: string;
	body: string;
	author: { id: number; username: string; name: string; avatar_url: string };
	created_at: string;
	updated_at: string;
	system: boolean;
	resolvable: boolean;
	resolved: boolean;
	/** Provider diff position, when the note is an inline comment. */
	position?: Record<string, unknown>;
	resolved_by?: {
		id: number;
		username: string;
		name: string;
		avatar_url: string;
	};
	resolved_at?: string;
}

export interface Discussion {
	id: string;
	individual_note: boolean;
	notes: Note[];
	/** Provider diff position for a thread anchored to a line. */
	position?: Record<string, unknown>;
}

/** CI job in the GitLab shape the TUI renders for both providers. */
export interface CiJob {
	id: number;
	name: string;
	stage: string;
	status: string;
	web_url: string;
	created_at?: string;
	started_at?: string;
	finished_at?: string;
	duration?: number;
	queued_duration?: number;
	pipeline: { id: number };
}

export interface TestCase {
	name: string;
	classname: string;
	status: string;
	execution_time: number;
	system_output?: string;
	stack_trace?: string;
}

export interface TestSuite {
	name: string;
	test_cases: TestCase[];
}

export interface TestSummary {
	total: number;
	success: number;
	failed: number;
	skipped: number;
	error: number;
	test_suites?: TestSuite[];
}

export interface DiffPosition {
	headSha: string;
	baseSha?: string;
	startSha?: string;
	newPath: string;
	oldPath?: string;
	newLine?: number;
	oldLine?: number;
}

/**
 * Parse a unified diff patch into positioned lines. Line identity follows the
 * Go implementation: `@@` hunks reset the counters, file headers are skipped
 * and every emitted line carries a content hash of provider/path/positions so
 * the TUI can key a comment to a line without a second request.
 */
export function parseDiffLines(patch: string, filePath: string): DiffLine[] {
	if (patch === "") return [];
	const lines: DiffLine[] = [];
	let currentOldLine = 0;
	let currentNewLine = 0;
	for (const line of patch.split("\n")) {
		if (line.length === 0) continue;
		if (line.startsWith("@@")) {
			const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(line);
			if (match) {
				currentOldLine = Number(match[1]);
				currentNewLine = Number(match[2]);
			}
			continue;
		}
		if (
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("\\")
		)
			continue;
		if (line.startsWith("+")) {
			const newLine = currentNewLine;
			lines.push({
				line_code: generateLineCode(filePath, newLine, null),
				type: "new",
				old_line: null,
				new_line: newLine,
				text: line,
				rich_text: "",
			});
			currentNewLine += 1;
			continue;
		}
		if (line.startsWith("-")) {
			const oldLine = currentOldLine;
			lines.push({
				line_code: generateLineCode(filePath, null, oldLine),
				type: "old",
				old_line: oldLine,
				new_line: null,
				text: line,
				rich_text: "",
			});
			currentOldLine += 1;
			continue;
		}
		const oldLine = currentOldLine;
		const newLine = currentNewLine;
		lines.push({
			line_code: generateLineCode(filePath, newLine, oldLine),
			type: "match",
			old_line: oldLine,
			new_line: newLine,
			text: line,
			rich_text: "",
		});
		currentOldLine += 1;
		currentNewLine += 1;
	}
	return lines;
}

/** `sha1("github:<path>:<old>:<new>")` — the Go line identity. */
export function generateLineCode(
	filePath: string,
	newLine: number | null,
	oldLine: number | null,
): string {
	const content = `github:${filePath}:${oldLine ?? ""}:${newLine ?? ""}`;
	return createHash("sha1").update(content).digest("hex");
}

/** Deterministic ordering for the approved-by list. The Go client iterated a
 * map, so its order was incidental; the port sorts by username and the
 * fixtures are captured in that order. */
export function sortApprovals(approvals: Approvals): Approvals {
	return {
		...approvals,
		approved_by: [...approvals.approved_by].sort((a, b) =>
			a.user.username < b.user.username
				? -1
				: a.user.username > b.user.username
					? 1
					: 0,
		),
	};
}
