export type GitRepositoryStatus = {
	repository: string;
	state: "clean" | "dirty" | "unknown";
	branch?: string;
	head?: string;
	detached?: boolean;
	ahead: number;
	behind: number;
	modified: number;
	added: number;
	deleted: number;
	changed: number;
	upstream?: string;
	reason?: "not-a-repository" | "timeout" | "unavailable";
};

export type GitChangeKind =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "conflicted"
	| "untracked";

export type GitChange = {
	path: string;
	originalPath?: string;
	kind: GitChangeKind;
	staged: boolean;
	worktree: boolean;
};

export type GitChanges = {
	repository: string;
	changes: readonly GitChange[];
	truncated: boolean;
	note?: "unavailable";
};

export type GitDiff = {
	repository: string;
	path: string;
	diff: string;
	binary: boolean;
	truncated: boolean;
	note?: "no-change" | "invalid-path" | "symlink" | "directory" | "unavailable";
};

export interface GitStatusPort {
	status(
		repositories: readonly string[],
		signal: AbortSignal,
	): Promise<readonly GitRepositoryStatus[]>;
	changes(repository: string, signal: AbortSignal): Promise<GitChanges>;
	diff(repository: string, path: string, signal: AbortSignal): Promise<GitDiff>;
}

export function unknownGitStatus(
	repository: string,
	reason: NonNullable<GitRepositoryStatus["reason"]>,
): GitRepositoryStatus {
	return {
		repository,
		state: "unknown",
		ahead: 0,
		behind: 0,
		modified: 0,
		added: 0,
		deleted: 0,
		changed: 0,
		reason,
	};
}

/** Parse `git status --porcelain=v2 --branch` without trusting or echoing
 * paths. Only the branch header and dirty-file counts are retained. */
export function parseGitStatusOutput(
	repository: string,
	output: string,
): GitRepositoryStatus {
	let branch: string | undefined;
	let head: string | undefined;
	let detached = false;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let modified = 0;
	let added = 0;
	let deleted = 0;
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.oid ")) {
			const value = line.slice(13).trim();
			if (value && value !== "(initial)") head = value.slice(0, 8);
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const value = line.slice(14).trim();
			if (value === "(detached)") detached = true;
			else if (value && value !== "(initial)") branch = value;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			const value = line.slice(18).trim();
			if (value) upstream = value;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
			if (match?.[1] && match[2]) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (line.startsWith("? ")) {
			added += 1;
			continue;
		}
		if (
			line.startsWith("1 ") ||
			line.startsWith("2 ") ||
			line.startsWith("u ")
		) {
			const x = line[2];
			const y = line[3];
			if (x === "A" || y === "A") added += 1;
			else if (x === "D" || y === "D") deleted += 1;
			else modified += 1;
		}
	}
	const changed = modified + added + deleted;
	return {
		repository,
		state: changed > 0 ? "dirty" : "clean",
		...(branch ? { branch } : {}),
		...(head ? { head } : {}),
		...(detached ? { detached: true } : {}),
		ahead,
		behind,
		modified,
		added,
		deleted,
		changed,
		...(upstream ? { upstream } : {}),
	};
}

function changeKind(xy: string, type: string): GitChangeKind {
	if (type === "?") return "untracked";
	if (type === "u") return "conflicted";
	const [x = ".", y = "."] = xy;
	if (type === "2") return x === "C" ? "copied" : "renamed";
	if (x === "D" || y === "D") return "deleted";
	if (x === "A" || y === "A") return "added";
	return "modified";
}

/** Parse NUL-delimited `git status --porcelain=v2 --branch -z` records. Only
 * paths, status classes and index/worktree presence are retained. */
export function parseGitChangesOutput(
	repository: string,
	output: string,
	limit = 500,
): GitChanges {
	const changes: GitChange[] = [];
	let truncated = false;
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const entry = fields[index];
		if (!entry) continue;
		if (entry.startsWith("#")) continue;
		let change: GitChange | undefined;
		if (entry.startsWith("? ")) {
			change = {
				path: entry.slice(2),
				kind: "untracked",
				staged: false,
				worktree: true,
			};
		} else if (entry.startsWith("! ")) {
			continue;
		} else {
			const ordinary = /^1 ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(
				entry,
			);
			const renamed = /^2 ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(
				entry,
			);
			const unmerged =
				/^u ([^\s]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(entry);
			const match = ordinary ?? renamed ?? unmerged;
			if (!match?.[1] || !match[2]) continue;
			const xy = match[1];
			const [x = ".", y = "."] = xy;
			const type = entry[0] ?? "";
			const originalPath =
				type === "2" ? (fields[index + 1] ?? undefined) : undefined;
			if (type === "2") index += 1;
			change = {
				path: match[2],
				...(originalPath ? { originalPath } : {}),
				kind: changeKind(xy, type),
				staged: x !== ".",
				worktree: y !== ".",
			};
		}
		if (!change) continue;
		if (changes.length >= limit) {
			truncated = true;
			break;
		}
		changes.push(change);
	}
	return { repository, changes, truncated };
}
