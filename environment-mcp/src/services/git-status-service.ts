import {
	readGitChanges,
	readGitDiff,
	readGitStatus,
} from "../adapters/process/git-status.ts";
import type { GitDiffSide, GitStatusPort } from "../domain/git-status.ts";

const concurrency = 8;

export function createGitStatusService(): GitStatusPort {
	return {
		changes(repository, signal) {
			return readGitChanges(repository, signal);
		},
		async diff(repository, path, signal, side: GitDiffSide = "all") {
			const changes = await readGitChanges(repository, signal);
			const change = changes.changes.find((entry) => entry.path === path);
			if (!change)
				return {
					repository,
					path,
					side,
					diff: "",
					binary: false,
					truncated: false,
					note: changes.note ?? "no-change",
				};
			return readGitDiff(repository, change, signal, side);
		},
		async status(repositories, signal) {
			const results: Awaited<ReturnType<GitStatusPort["status"]>>[number][] =
				new Array(repositories.length);
			let next = 0;
			await Promise.all(
				Array.from(
					{ length: Math.min(concurrency, repositories.length) },
					async () => {
						for (;;) {
							const index = next;
							next += 1;
							const repository = repositories[index];
							if (!repository) return;
							results[index] = await readGitStatus(repository, signal);
						}
					},
				),
			);
			return results;
		},
	};
}
