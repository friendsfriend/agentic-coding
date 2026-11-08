import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Conversation, Harness, TaskId } from "@earendil-works/pi-durable";
import { taskActivities } from "./activity.ts";
import type { Config } from "./config.ts";
import { gitOverview } from "./git.ts";
import {
	Catalog,
	type Review,
	type Schedule,
	type TaskInfo,
	type Topic,
	values,
} from "./state.ts";

const nativeTaskId = (id: number) => id as TaskId;
export async function projectState(
	harness: Harness,
	home: Conversation,
	config: Config,
	models: Models,
) {
	const doc = await harness.snapshot(Catalog, context);
	const infos = values<TaskInfo>(doc?.tasks);
	const activities = await taskActivities(
		harness,
		infos.map((info) => info.id),
	);
	const tasks = await Promise.all(
		infos.map(async (info) => {
			const task = await harness.getTask(nativeTaskId(info.id), context);
			const waiting =
				task?.state.status !== "terminal" &&
				values<Review>(doc?.reviews).some(
					(review) => review.taskId === info.id && review.state === "pending",
				);
			const activity = activities.get(info.id);
			return {
				...info,
				// Native task state, not the activity/detail label or legacy workflow status.
				status: task?.state.status ?? null,
				activity:
					waiting || !task || task.state.status === "terminal"
						? "idle"
						: (activity?.activity ?? "idle"),
				detail: waiting
					? "awaiting review"
					: task?.state.status === "terminal"
						? task.state.outcome.status
						: task
							? (activity?.detail ?? task.state.status)
							: "missing",
				result: task?.state.status === "terminal" ? task.state.outcome : null,
			};
		}),
	);
	const entries = await home.entries(
		{ order: "descending" },
		500,
		undefined,
		context,
	);
	const messages = [...entries.items]
		.reverse()
		.flatMap((entry) =>
			(entry.model ?? [])
				.filter(
					(message) => message.role === "user" || message.role === "assistant",
				)
				.map((message) => ({
					id: `${entry.id}:${message.role}`,
					role: message.role,
					content:
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
				})),
		)
		.filter((message) => message.content);
	const profiles = await Promise.all(
		config.profiles.map(async (profile) => {
			let available = false;
			try {
				available = Boolean(
					models.getModel(profile.provider, profile.modelId) &&
						(await models.checkAuth(profile.provider)),
				);
			} catch {
				available = false;
			}
			return { ...profile, available };
		}),
	);
	return {
		profiles,
		skills: config.skills.map(
			({ id, description, origin, digest: revision }) => ({
				id,
				origin,
				description,
				revision,
			}),
		),
		repositories: config.repositories,
		topics: values<Topic>(doc?.topics),
		tasks,
		reviews: values<Review>(doc?.reviews),
		schedules: values<Schedule>(doc?.schedules),
		messages,
		git: await Promise.all(
			[...new Set(tasks.map((task) => task.workspace).filter(Boolean))].map(
				gitOverview,
			),
		),
	};
}
