import fs from "node:fs";
import {
	deleteDurableSession,
	durableSessionOwner,
	readDurableSessionRegistry,
	requireDurableSession,
	selectDurableSession,
} from "../pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../pi-durable-state.ts";
import {
	dailyDigestJobMigration,
	dailyDigestProposal,
} from "../scheduling/daily-digest-setup.ts";
import { HostClient } from "./client.ts";
import { previewDigestSessionUpdate } from "./digest-session-update.ts";
import { hostLayout } from "./layout.ts";
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
		if (
			command === "digest-settings-preview" ||
			command === "digest-settings-apply"
		) {
			const [id, flag, file, revisionFlag, revision] = rest;
			const apply = command === "digest-settings-apply";
			if (
				!id ||
				flag !== "--settings" ||
				!file ||
				rest.length !== (apply ? 5 : 3) ||
				(apply &&
					(revisionFlag !== "--expected-revision" ||
						!revision ||
						!/^[a-f0-9]{64}$/.test(revision)))
			)
				throw new Error(
					"Digest settings requires ID --settings FILE; apply also requires --expected-revision SHA256.",
				);
			const raw = fs.readFileSync(file, "utf8");
			if (Buffer.byteLength(raw) > 16000)
				throw new Error("Digest settings file exceeds the byte bound.");
			const preview = previewDigestSessionUpdate(
				runtimeDir,
				id,
				owner,
				JSON.parse(raw),
			);
			if (apply) {
				if (preview.expectedRevision !== revision)
					throw new Error("Stale collection settings preview.");
				await new HostClient(
					hostLayout(runtimeDir).socketPath,
				).updateDigestSettings({
					sessionId: id,
					expectedRevision: preview.expectedRevision,
					settings: preview.settings,
				});
			}
			print(JSON.stringify({ ...preview, applied: apply }, null, 2));
			return 0;
		}
		if (command === "digest-job-update-proposal") {
			const [
				id,
				jobFlag,
				file,
				scheduleFlag,
				scheduleId,
				settingsFlag,
				settingsFile,
			] = rest;
			if (
				!id ||
				jobFlag !== "--job" ||
				!file ||
				scheduleFlag !== "--schedule" ||
				!scheduleId ||
				!(
					rest.length === 5 ||
					(rest.length === 7 && settingsFlag === "--settings" && !!settingsFile)
				)
			)
				throw new Error(
					"Job migration proposal requires ID --job FILE --schedule ID [--settings FILE].",
				);
			const registry = readDurableSessionRegistry(runtimeDir);
			if (!registry) throw new Error("Durable session registry unavailable.");
			const raw = fs.readFileSync(file, "utf8");
			if (Buffer.byteLength(raw) > 80000)
				throw new Error("Stored job snapshot exceeds the byte bound.");
			const settingsRaw = settingsFile
				? fs.readFileSync(settingsFile, "utf8")
				: undefined;
			if (settingsRaw && Buffer.byteLength(settingsRaw) > 16000)
				throw new Error("Digest settings exceed the byte bound.");
			print(
				JSON.stringify(
					dailyDigestJobMigration(
						requireDurableSession(registry, id, owner),
						JSON.parse(raw),
						scheduleId,
						settingsRaw === undefined ? undefined : JSON.parse(settingsRaw),
					),
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
			"Usage: agentic-coding session list | create --name NAME --cwd DIR --model PROVIDER/MODEL --thinking LEVEL --operation-id ID [--collection] [--select] [--gitlab-hosts HOST,...] [--gitlab-tool-host HOST] [--repository-roots DIR,...] | select ID | delete ID | digest-proposal ID --base-branch BRANCH | digest-settings-preview ID --settings FILE | digest-settings-apply ID --settings FILE --expected-revision REVISION | digest-job-update-proposal ID --job FILE --schedule ID [--settings FILE]\nPreview/proposal do not mutate settings or jobs. Apply requires the expected revision and idle existing host.\nCreation is background by default. Deletion tombstones metadata; native history is retained. No schedule is created or activated.",
		);
		return command === "--help" || command === "help" || command === undefined
			? 0
			: 2;
	} catch (error) {
		print(error instanceof Error ? error.message : "Session operation failed.");
		return 2;
	}
}
