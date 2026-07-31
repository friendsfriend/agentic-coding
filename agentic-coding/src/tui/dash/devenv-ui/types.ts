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

export interface Discussion {
  id: string;
  individual_note: boolean;
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
