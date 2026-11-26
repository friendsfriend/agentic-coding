export type GitBranch = {
	name: string;
	current: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	gone?: boolean;
};

export type GitBranches = {
	repository: string;
	branches: readonly GitBranch[];
	current?: string;
	note?: "unavailable";
};

export type GitWorktree = {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	current: boolean;
	locked?: string;
	prunable?: string;
};

export type GitWorktrees = {
	repository: string;
	worktrees: readonly GitWorktree[];
	note?: "unavailable";
};

export type GitRemote = {
	name: string;
	fetchUrl: string;
	pushUrl?: string;
};

export type GitRemotes = {
	repository: string;
	remotes: readonly GitRemote[];
	note?: "unavailable";
};

export type GitActionRequest =
	| { action: "fetch" }
	| { action: "pull" }
	| { action: "checkout"; branch: string }
	| { action: "branch-delete"; branch: string }
	| { action: "remote-add"; name: string; url: string }
	| { action: "remote-remove"; name: string }
	| { action: "stage"; path: string }
	| { action: "unstage"; path: string }
	| { action: "stage-all" }
	| { action: "unstage-all" }
	| {
			action: "worktree-add";
			path: string;
			branch: string;
			create: boolean;
	  }
	| { action: "worktree-remove"; path: string };

export type GitTag = {
	name: string;
	sha: string;
	annotated: boolean;
	date?: string;
	subject?: string;
};

export type GitTags = {
	repository: string;
	tags: readonly GitTag[];
	note?: "unavailable";
};

export type GitStash = {
	index: number;
	ref: string;
	branch?: string;
	message: string;
	date?: string;
};

export type GitStashes = {
	repository: string;
	stashes: readonly GitStash[];
	note?: "unavailable";
};

export type GitWriteRequest =
	| {
			action: "push";
			branch: string;
			remote: string;
			setUpstream: boolean;
	  }
	| {
			action: "push-force";
			branch: string;
			remote: string;
	  }
	| { action: "tag"; name: string; message?: string }
	| { action: "tag-delete"; name: string }
	| { action: "stash-pop"; index: number }
	| { action: "stash-apply"; index: number }
	| { action: "stash-drop"; index: number }
	| { action: "branch-rename"; branch: string; name: string }
	| { action: "remote-set-url"; name: string; url: string }
	| { action: "commit"; message: string }
	| { action: "commit-all"; message: string }
	| { action: "stash"; message?: string }
	| { action: "merge"; branch: string }
	| { action: "rebase"; branch: string }
	| { action: "rebase-abort" };

export type GitWriteOutcome =
	| {
			status: "confirmation-required";
			digest: string;
			intent: {
				repository: string;
				action: GitWriteRequest["action"];
				target: string;
			};
	  }
	| {
			status: "completed" | "replayed";
			digest: string;
			outcome: GitActionOutcome;
	  };

export type GitActionOutcome = {
	repository: string;
	action: string;
	status: "completed" | "refused" | "failed";
	output: string;
	truncated: boolean;
	reason?: string;
	branch?: string;
	path?: string;
	head?: string;
};

export interface GitActionPort {
	branches(repository: string, signal: AbortSignal): Promise<GitBranches>;
	worktrees(repository: string, signal: AbortSignal): Promise<GitWorktrees>;
	remotes(repository: string, signal: AbortSignal): Promise<GitRemotes>;
	tags(repository: string, signal: AbortSignal): Promise<GitTags>;
	stashes(repository: string, signal: AbortSignal): Promise<GitStashes>;
	run(
		repository: string,
		request: GitActionRequest,
		signal: AbortSignal,
	): Promise<GitActionOutcome>;
	write(
		repository: string,
		request: GitWriteRequest,
		requestId: string,
		confirm: string | undefined,
		signal: AbortSignal,
	): Promise<GitWriteOutcome>;
}
