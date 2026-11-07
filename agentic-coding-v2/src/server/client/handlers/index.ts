import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { text } from "../../../config.ts";
import type { OperatorAction } from "../../../environment/operator.ts";
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
import { readEvidence } from "./evidence.ts";
import { SessionHistory } from "./history.ts";
import { inspectProvider } from "./providers.ts";
import { clientSession, clientSnapshot, readSession } from "./sessions.ts";
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
			fields(input, ["taskId", "id"]);
			return readEvidence(
				app,
				integer(input.taskId),
				text(input.id, "evidence identity", 64),
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
				taskId: await app.startEnvironmentAction(input as OperatorAction),
			};
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
