import fs from "node:fs";
import {
	deleteDurableSession,
	durableSessionOwner,
	readDurableSessionRegistry,
	requireDurableSession,
	selectDurableSession,
} from "../pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../pi-durable-state.ts";
import { dailyDigestProposal } from "../scheduling/daily-digest-setup.ts";
import { HostClient } from "./client.ts";
import { openPiDurableSession } from "./pi-durable-session.ts";
export async function sessionCommand(
	args: readonly string[],
	options: {
		configDir?: string;
		print?: (value: string) => void;
		open?: typeof openPiDurableSession;
		models?: () => Promise<readonly string[]>;
	} = {},
): Promise<number> {
	const print = options.print ?? console.log;
	const runtimeDir = piDurableRuntimeDir(options.configDir),
		owner = durableSessionOwner();
	const [command, ...rest] = args;
	try {
		if (command === "list") {
			if (rest.length) throw new Error("session list accepts no arguments.");
			const registry = readDurableSessionRegistry(runtimeDir);
			print(
				JSON.stringify(
					{
						activeId: registry?.activeId ?? null,
						sessions:
							registry?.sessions.filter(
								(record) =>
									record.owner === owner && record.deletedAt === undefined,
							) ?? [],
					},
					null,
					2,
				),
			);
			return 0;
		}
		if (command === "digest-proposal") {
			const [id, flag, base] = rest;
			if (!id || flag !== "--base-branch" || !base || rest.length !== 3)
				throw new Error(
					"session digest-proposal requires ID --base-branch BRANCH.",
				);
			const registry = readDurableSessionRegistry(runtimeDir);
			if (!registry)
				throw new Error("Durable session registry is unavailable.");
			print(
				JSON.stringify(
					dailyDigestProposal(requireDurableSession(registry, id, owner), base),
					null,
					2,
				),
			);
			return 0;
		}
		if (command === "create") {
			const flags = new Map<string, string>();
			let collection = false,
				select = false;
			for (let index = 0; index < rest.length; index++) {
				const flag = rest[index];
				if (flag === "--collection") {
					collection = true;
					continue;
				}
				if (flag === "--select") {
					select = true;
					continue;
				}
				if (
					!flag ||
					![
						"--name",
						"--cwd",
						"--model",
						"--thinking",
						"--operation-id",
						"--gitlab-hosts",
						"--gitlab-tool-host",
						"--repository-roots",
					].includes(flag) ||
					flags.has(flag)
				)
					throw new Error("Unknown or duplicate session creation option.");
				const value = rest[++index];
				if (!value || value.startsWith("--"))
					throw new Error("Missing session option value.");
				flags.set(flag, value);
			}
			const name = flags.get("--name"),
				cwd = flags.get("--cwd"),
				model = flags.get("--model"),
				thinking = flags.get("--thinking"),
				operationId = flags.get("--operation-id");
			if (!name || !cwd || !model || !thinking || !operationId)
				throw new Error(
					"Creation requires --name, --cwd, --model, --thinking and a stable --operation-id (reuse it for retries).",
				);
			if (
				!(
					await (
						options.models ??
						(async () =>
							(await import("./configured-models.ts")).configuredModelList())
					)()
				).includes(model)
			)
				throw new Error("Requested configured model is unavailable.");
			const session = await (options.open ?? openPiDurableSession)({
				fresh: true,
				name,
				cwd: fs.realpathSync(cwd),
				model: { model, thinking },
				operationId,
				select,
				toolPolicy: collection ? "collection" : "default",
				...(flags.get("--gitlab-tool-host")
					? { gitlabToolHost: flags.get("--gitlab-tool-host")?.toLowerCase() }
					: {}),
				...(flags.get("--gitlab-hosts")
					? { gitlabHosts: flags.get("--gitlab-hosts")?.split(",") }
					: {}),
				...(flags.get("--repository-roots")
					? {
							repositoryRoots: flags
								.get("--repository-roots")
								?.split(",")
								.map((root) => fs.realpathSync(root)),
						}
					: {}),
				configDir: options.configDir,
			});
			print(JSON.stringify(session));
			return 0;
		}
		if (command === "select" || command === "delete") {
			const [id] = rest;
			if (!id || rest.length !== 1)
				throw new Error(`session ${command} requires one exact session ID.`);
			const registry = readDurableSessionRegistry(runtimeDir);
			if (!registry)
				throw new Error("Durable session registry is unavailable.");
			const record = requireDurableSession(registry, id, owner);
			if (command === "select") selectDurableSession(runtimeDir, id, owner);
			else {
				// Revoke at the host's serialized admission boundary BEFORE acknowledging
				// the tombstone. Failure leaves metadata intact and deletion unacknowledged.
				if (record.binding) {
					const opened = await (options.open ?? openPiDurableSession)({
						sessionId: id,
						configDir: options.configDir,
						select: false,
					});
					await new HostClient(opened.hostSocket).revokeSession(
						record.runId,
						record.binding.hostId,
						record.binding.conversationId,
					);
				}
				deleteDurableSession(runtimeDir, id, owner);
			}
			print(JSON.stringify({ id, action: command }));
			return 0;
		}
		print(
			"Usage: agentic-coding session list | create --name NAME --cwd DIR --model PROVIDER/MODEL --thinking LEVEL --operation-id ID [--collection] [--select] [--gitlab-hosts HOST,...] [--repository-roots DIR,...] | select ID | delete ID | digest-proposal ID --base-branch BRANCH\nCreation is background by default. Deletion tombstones metadata; native history is retained. No schedule is created or activated.",
		);
		return command === "--help" || command === "help" || command === undefined
			? 0
			: 2;
	} catch (error) {
		print(error instanceof Error ? error.message : "Session operation failed.");
		return 2;
	}
}
