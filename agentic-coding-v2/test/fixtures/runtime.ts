import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { type Config, digest } from "../../src/config.ts";
import { git } from "../../src/git.ts";
import { Runtime } from "../../src/runtime.ts";

export function createFixtures() {
	const roots: string[] = [],
		apps: Runtime[] = [];
	async function cleanup() {
		for (const app of apps.splice(0)) await app.close();
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	}
	async function fixture(
		persistent = false,
		configure?: (config: Config) => void,
	) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-test-"));
		roots.push(root);
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		await git(repo, ["init", "-b", "main"]);
		await git(repo, ["config", "user.name", "Test"]);
		await git(repo, ["config", "user.email", "test@example.invalid"]);
		fs.writeFileSync(path.join(repo, "README.md"), "Initial\n");
		await git(repo, ["add", "README.md"]);
		await git(repo, ["commit", "-m", "initial"]);
		const fake = fauxProvider({
			models: [{ id: "original" }, { id: "replacement" }],
		});
		const models = createModels();
		models.setProvider(fake.provider);
		const model = fake.getModel();
		const stateDir = path.join(root, "state");
		fs.mkdirSync(stateDir);
		const config: Config = {
			profiles: [
				{
					id: "test",
					provider: model.provider,
					modelId: model.id,
					thinking: "off",
					description: "test",
				},
			],
			orchestratorProfile: "test",
			repositories: [fs.realpathSync(repo)],
			providers: [],
			skills: [
				{
					id: "code",
					origin: "system",
					content: "Implement the task",
					description: "test skill",
					digest: digest("Implement the task"),
					readOnly: false,
				},
			],
			stateDir,
			configDir: path.join(root, "config"),
		};
		configure?.(config);
		const open = async () => {
			const app = await Runtime.open(
				config,
				models,
				persistent
					? await openNodeJsonlStorage(path.join(stateDir, "native"), context, {
							fsync: true,
						})
					: new MemoryStorage(),
			);
			apps.push(app);
			return app;
		};
		const app = await open();
		const invocation = {
			policy: "workspace-write" as const,
			topicId: "Improve task execution",
			skill: "code",
			profile: "test",
			repository: config.repositories[0],
			inputs: "Explain the change",
			requestId: "task-1",
		};
		return { app, config, fake, open, invocation };
	}
	return { fixture, cleanup, apps };
}
export async function eventually<T>(
	read: () => Promise<T>,
	check: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const value = await read();
		if (check(value)) return value;
		await Bun.sleep(10);
	}
	throw new Error("Condition did not become true");
}
