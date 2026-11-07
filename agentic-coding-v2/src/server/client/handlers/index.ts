import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { text } from "../../../config.ts";
import type { OperatorAction } from "../../../environment/operator.ts";
import type { Data, Request } from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";
import { inspectProvider } from "./providers.ts";
import { clientSession, clientSnapshot, readSession } from "./sessions.ts";
import { readTask } from "./tasks.ts";

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
		case "environment.action":
			return {
				taskId: await app.startEnvironmentAction(input as OperatorAction),
			};
		case "environment.logs":
			fields(input, ["app"]);
			return app.environments.logs(text(input.app, "app", 64));
		case "providers.inspect":
			return inspectProvider(app, input);
		case "providers.read":
			fields(input, []);
			return app.environments.providers.list();
	}
}
