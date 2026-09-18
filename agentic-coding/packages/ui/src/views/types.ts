// Shared review types: a change-request file change, a comment position, and
// the annotation envelope. One envelope covers review comments and review
// findings — a finding is a discussion with `findingId`/`findingSeverity`, so
// both render through the same thread component.
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
	review_finding_count?: number;
}

export interface NotePosition {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	old_path: string;
	new_path: string;
	position_type: string;
	old_line?: number;
	new_line?: number;
}

/** One annotation on a diff line: a comment thread, or a finding thread. */
export interface Discussion {
	id: string;
	individual_note: boolean;
	/** Set for a review finding; its presence switches the thread to FIX style. */
	findingId?: string;
	findingSeverity?: "warning" | "info";
	notes: Array<{
		id: number;
		type: string;
		body: string;
		author: { name: string };
		created_at: string;
		updated_at: string;
		system: boolean;
		resolvable: boolean;
		resolved: boolean;
		position?: NotePosition;
	}>;
	position?: NotePosition;
}
