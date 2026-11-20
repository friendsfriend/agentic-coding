import fs from "node:fs";
import path from "node:path";
import { ControllerRefusal, type WorkspaceIdentity } from "./state.ts";

function identity(directory: string) {
	const stat = fs.lstatSync(directory, { bigint: true });
	if (!stat.isDirectory() || fs.realpathSync(directory) !== directory)
		throw new ControllerRefusal("workspace-unavailable");
	return { device: String(stat.dev), inode: String(stat.ino) };
}

export function captureWorkspace(
	repositories: readonly string[],
	repository: string,
	directory: string,
): WorkspaceIdentity {
	try {
		if (
			!repositories.includes(repository) ||
			!path.isAbsolute(directory) ||
			directory.length > 4096
		)
			throw new ControllerRefusal("workspace-unavailable");
		const relative = path.relative(repository, directory);
		if (
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			throw new ControllerRefusal("workspace-unavailable");
		const root = identity(repository);
		const workspace = identity(directory);
		return {
			repository,
			directory,
			repositoryDevice: root.device,
			repositoryInode: root.inode,
			...workspace,
		};
	} catch {
		throw new ControllerRefusal("workspace-unavailable");
	}
}

export function workspaceMatches(workspace: WorkspaceIdentity): boolean {
	try {
		const root = identity(workspace.repository);
		const directory = identity(workspace.directory);
		return (
			root.device === workspace.repositoryDevice &&
			root.inode === workspace.repositoryInode &&
			directory.device === workspace.device &&
			directory.inode === workspace.inode
		);
	} catch {
		return false;
	}
}
