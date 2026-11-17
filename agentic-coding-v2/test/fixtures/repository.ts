import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../../src/git.ts";

type Entry = { name: string; data: Buffer; mode: number };
let seed: Promise<Entry[]> | undefined;

async function repositorySeed(): Promise<Entry[]> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-repo-seed-"));
	try {
		await git(root, ["init", "-b", "main"]);
		await git(root, ["config", "user.name", "Test"]);
		await git(root, ["config", "user.email", "test@example.invalid"]);
		fs.writeFileSync(path.join(root, "README.md"), "Initial\n");
		await git(root, ["add", "README.md"]);
		await git(root, ["commit", "-m", "initial"]);
		return fs.readdirSync(root, { recursive: true }).flatMap((entry) => {
			const name = String(entry),
				file = path.join(root, name),
				stat = fs.statSync(file);
			return stat.isFile()
				? [{ name, data: fs.readFileSync(file), mode: stat.mode & 0o777 }]
				: [];
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** Copy bytes, never share a mutable checkout, index, config or object database.
 * Only the initial repository construction is cached; every test owns its files.
 */
export async function createRepository(repo: string) {
	seed ??= repositorySeed();
	for (const entry of await seed) {
		const file = path.join(repo, entry.name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, entry.data, { mode: entry.mode });
	}
}
