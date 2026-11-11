import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { text } from "../../../config.ts";
import {
	type ClusterOperation,
	clusterOperations,
} from "../../../environment/cluster-operator.ts";
import type { OperatorAction } from "../../../environment/operator.ts";
import {
	type GitOperation,
	gitOperations,
} from "../../../environment/repository-git.ts";
import type {
	EnvironmentInspection,
	EnvironmentIntention,
} from "../../../protocol/environment-workbench.ts";
import type { Data, Request } from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";
import {
	readViewpoints,
	removeViewpoint,
	saveViewpoint,
} from "../../../viewpoints.ts";
import { Refusal } from "../../refusal.ts";
import { readEvidence } from "./evidence.ts";
import { SessionHistory } from "./history.ts";
import { inspectProvider } from "./providers.ts";
import {
	clientSession,
	clientSnapshot,
	readContext,
	readSession,
} from "./sessions.ts";
import { listSkills, readSkill } from "./skills.ts";
import { readTask } from "./tasks.ts";

const histories = new WeakMap<Runtime, SessionHistory>();
function fields(input: Data, allowed: string[]) {
	if (Object.keys(input).some((key) => !allowed.includes(key)))
		throw new Error("Unsupported command field");
}
function integer(value: unknown) {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error("Invalid identity or revision");
	return Number(value);
}
export async function dispatch(
	app: Runtime,
	{ method, input }: Request,
): Promise<unknown> {
	switch (method) {
		case "viewpoints.read":
			fields(input, []);
			return readViewpoints(app);
		case "viewpoints.save":
			fields(input, ["id", "name", "revision", "view"]);
			return saveViewpoint(app, {
				id: text(input.id, "viewpoint identity", 80),
				name: text(input.name, "viewpoint name", 100),
				revision: integer(input.revision),
				view: input.view,
			});
		case "viewpoints.remove":
			fields(input, ["id", "revision"]);
			return removeViewpoint(
				app,
				text(input.id, "viewpoint identity", 80),
				integer(input.revision),
			);
		case "state.read":
			fields(input, []);
			return clientSnapshot(app);
		case "state.subscribe":
			fields(input, []);
			return { subscribed: true };
		case "session.watch":
			throw new Error(
				"Session observation requires a native client connection",
			);
		case "session.history": {
			fields(input, ["id", "cursor"]);
			let history = histories.get(app);
			if (!history) {
				history = new SessionHistory(app);
				histories.set(app, history);
			}
			return history.read(
				integer(input.id),
				input.cursor === undefined
					? undefined
					: text(input.cursor, "history cursor", 80),
			);
		}
		case "standalone.read":
			fields(input, ["id"]);
			return app.standalone.read(
				input.id === undefined
					? undefined
					: text(input.id, "standalone identity", 80),
			);
		case "standalone.create":
			fields(input, ["mode", "profile", "repository", "title"]);
			if (input.mode !== "pi" && input.mode !== "opencode")
				throw new Error("Invalid standalone mode");
			return app.standalone.create(
				input.mode,
				text(input.profile, "profile", 128),
				text(input.repository, "repository", 4096),
				text(input.title, "title", 256),
			);
		case "standalone.send":
			fields(input, ["id", "revision", "content", "requestId"]);
			return app.standalone.send(
				text(input.id, "standalone identity", 80),
				integer(input.revision),
				text(input.content, "message", 64000),
				text(input.requestId, "request identity", 128),
			);
		case "standalone.compact":
			fields(input, ["id", "revision", "requestId", "instructions"]);
			return app.standalone.send(
				text(input.id, "standalone identity", 80),
				integer(input.revision),
				input.instructions === undefined
					? "Native context compaction"
					: text(input.instructions, "instructions", 32000),
				text(input.requestId, "request identity", 128),
				true,
			);
		case "standalone.configure":
			fields(input, ["id", "revision", "profile"]);
			await app.standalone.configure(
				text(input.id, "standalone identity", 80),
				integer(input.revision),
				text(input.profile, "profile", 128),
			);
			return { configured: true };
		case "standalone.retire":
			fields(input, ["id", "revision"]);
			await app.standalone.retire(
				text(input.id, "standalone identity", 80),
				integer(input.revision),
			);
			return { retired: true };
		case "standalone.abort":
			fields(input, ["id"]);
			await app.standalone.abort(text(input.id, "standalone identity", 80));
			return { aborted: true };
		case "session.context":
			fields(input, ["id"]);
			return readContext(app, integer(input.id));
		case "session.read":
			fields(input, ["id"]);
			return readSession(app, integer(input.id));
		case "session.send": {
			fields(input, ["id", "content", "requestId"]);
			const session = await clientSession(app, integer(input.id));
			const content = text(input.content, "message", 64000),
				requestId = text(input.requestId, "submission identity", 128);
			if (session.id === app.home.id)
				return { submissionId: await app.chat(content, requestId) };
			return {
				submissionId: Number(
					(
						await session.submit(
							{
								type: "input",
								content,
								requestId: `client:${requestId}`,
								whenBusy: "followUp",
							},
							context,
						)
					).id,
				),
			};
		}
		case "session.abort":
			fields(input, ["id"]);
			await (await clientSession(app, integer(input.id))).abort(context);
			return { aborted: true };
		case "session.compact": {
			fields(input, ["id", "instructions"]);
			const instructions =
				input.instructions === undefined
					? undefined
					: text(input.instructions, "compaction instructions", 16000);
			return {
				taskId: Number(
					await (await clientSession(app, integer(input.id))).compact(
						instructions,
						context,
					),
				),
			};
		}
		case "session.configure": {
			fields(input, ["id", "profile"]);
			const profile = app.config.profiles.find(
				(item) => item.id === input.profile,
			);
			if (!profile || !app.models.getModel(profile.provider, profile.modelId))
				throw new Error("Configured model is unavailable");
			await (await clientSession(app, integer(input.id))).configure(
				{
					model: { provider: profile.provider, modelId: profile.modelId },
					thinkingLevel: profile.thinking,
				},
				context,
			);
			return { configured: true };
		}
		case "evidence.read":
			fields(input, ["taskId", "id", "offset"]);
			return readEvidence(
				app,
				integer(input.taskId),
				text(input.id, "evidence identity", 64),
				input.offset === undefined ? 0 : integer(input.offset),
			);
		case "task.read":
			fields(input, ["id"]);
			return readTask(app, integer(input.id));
		case "task.cancel":
			fields(input, ["id"]);
			return { requested: await app.cancel(integer(input.id)) };
		case "review.decide": {
			fields(input, ["id", "revision", "decision", "comments"]);
			const decision = input.decision;
			if (
				decision !== "approved" &&
				decision !== "rejected" &&
				decision !== "changes-requested"
			)
				throw new Error("Invalid review decision");
			if (typeof input.comments !== "string")
				throw new Error("Expected review comments");
			await app.decide(
				text(input.id, "review identity", 128),
				integer(input.revision),
				decision,
				input.comments,
			);
			return { decided: true };
		}
		case "schedule.delete":
			fields(input, ["id", "revision"]);
			await app.scheduler.remove(
				text(input.id, "schedule identity", 128),
				integer(input.revision),
			);
			return { deleted: true };
		case "environment.inspect":
			return app.environmentWorkbench.inspect(input as EnvironmentInspection);
		case "environment.preview":
			return app.environmentWorkbench.preview(input as EnvironmentIntention);
		case "environment.apply":
			fields(input, ["id", "approval"]);
			return app.environmentWorkbench.apply(
				text(input.id, "candidate", 80),
				text(input.approval, "exact approval", 80),
			);
		case "environment.action":
			return {
				taskId: await app.startEnvironmentAction(input as OperatorAction, true),
			};
		case "environment.stop":
			fields(input, ["runId", "revision", "requestId"]);
			return app.stopEnvironmentRun({
				runId: text(input.runId, "run identity", 512),
				revision: integer(input.revision),
				requestId: text(input.requestId, "request identity", 256),
			});
		case "environment.git": {
			fields(input, ["operation", "app", "branch"]);
			const operation = text(input.operation, "Git operation", 32);
			if (operation === "status") return app.repositoryGit.status();
			if (operation === "branches")
				return app.repositoryGit.branches(input.app);
			if (operation === "worktrees")
				return app.repositoryGit.worktrees(input.app);
			if (!gitOperations.includes(operation as GitOperation))
				throw new Error("Unsupported Git operation");
			// A direct developer action in the authenticated TUI is its approval.
			return app.repositoryGit.mutate(
				operation as GitOperation,
				input.app,
				input.branch,
			);
		}
		case "environment.cluster": {
			fields(input, ["operation", "cluster", "requestId"]);
			const operation = text(input.operation, "cluster operation", 32);
			if (operation === "status")
				return app.clusterOperator.status(input.cluster);
			if (operation === "operations") return app.clusterOperator.receipts();
			if (!clusterOperations.includes(operation as ClusterOperation))
				throw new Error("Unsupported cluster operation");
			// A direct developer action in the authenticated TUI is its approval.
			return app.clusterOperator.start(
				operation as ClusterOperation,
				input.cluster,
				input.requestId,
			);
		}
		case "environment.stats":
			fields(input, ["app"]);
			return app.environments.stats(text(input.app, "app", 64)).catch(() => {
				throw new Refusal("No live owned container statistics are available");
			});
		case "environment.logs":
			fields(input, ["app"]);
			return app.environments.logs(text(input.app, "app", 64));
		case "wiki.list":
			fields(input, []);
			return app.wiki.list();
		case "wiki.read":
			fields(input, ["id"]);
			return app.wiki.read(input.id);
		case "wiki.preview":
			return app.wiki.preview(input);
		case "wiki.apply":
			return app.wiki.apply(input);
		case "wiki.comment":
			return app.wiki.comment(input);
		case "skill-file.read":
			fields(input, ["name"]);
			return app.skillFiles.read(text(input.name, "skill slug", 64));
		case "skill-file.preview":
			fields(input, ["name", "baseRevision", "content"]);
			return app.skillFiles.preview(
				text(input.name, "skill slug", 64),
				text(input.baseRevision, "skill file revision", 64),
				text(input.content, "skill text", 64000),
			);
		case "skill-file.apply":
			fields(input, ["id", "approval"]);
			return app.skillFiles.apply(
				text(input.id, "candidate identity", 80),
				text(input.approval, "skill approval", 80),
			);
		case "skills.read":
			fields(input, []);
			return listSkills(app);
		case "skill.read":
			fields(input, ["id", "revision"]);
			return readSkill(app, input.id, input.revision);
		case "settings.read":
			fields(input, []);
			return app.settings.read();
		case "settings.preview":
			fields(input, ["baseRevision", "settings"]);
			return app.settings.preview(input.baseRevision, input.settings);
		case "settings.apply":
			fields(input, ["id", "approval"]);
			return app.settings.apply(input.id, input.approval);
		case "providers.inspect":
			return inspectProvider(app, input);
		case "providers.receipt":
			fields(input, ["provider", "requestId"]);
			return app.providerActions.receipt(
				text(input.provider, "provider", 64),
				text(input.requestId, "request ID", 128),
			);
		case "providers.actions":
			fields(input, ["provider"]);
			return app.providerActions.list(text(input.provider, "provider", 64));
		case "providers.preview":
			return app.providerActions.preview(input);
		case "providers.apply":
			fields(input, ["id", "approval"]);
			return app.providerActions.apply(
				text(input.id, "candidate identity", 80),
				text(input.approval, "exact approval", 80),
			);
		case "providers.read":
			fields(input, []);
			return app.environments.providers.list();
	}
}
