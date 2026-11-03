// An isolated crash-test host: faux model, temporary repo/state, no real providers.
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Config } from "../../src/config.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Invocation } from "../../src/state.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as {
	config: Config;
	invocation: Invocation;
	readyFile: string;
	target?: string;
};
const fake = fauxProvider({
	models: [{ id: "original" }, { id: "replacement" }],
});
const models = createModels();
models.setProvider(fake.provider);
fake.setResponses([
	fauxAssistantMessage(
		fauxToolCall("env_start", {
			apps: ["api"],
			target: input.target ?? "serve",
		}),
		{
			stopReason: "toolUse",
		},
	),
	fauxAssistantMessage(
		fauxToolCall("request_review", {
			path: ".",
			title: "Keep crash fixture alive",
		}),
		{ stopReason: "toolUse" },
	),
]);
const app = await Runtime.open(
	input.config,
	models,
	await openNodeJsonlStorage(`${input.config.stateDir}/native`, context, {
		fsync: true,
	}),
);
process.on("SIGTERM", () => {
	void app.close().then(() => process.exit(0));
});
const id = await app.startTask(input.invocation);
let approved = false;
for (let attempt = 0; attempt < 1000; attempt++) {
	const state = await app.snapshot();

	const approval = state.reviews.find(
		(review) =>
			review.taskId === id &&
			review.title.startsWith("Environment ") &&
			review.state === "pending",
	);
	if (approval && !approved) {
		await app.decide(
			approval.id,
			approval.revision,
			"approved",
			"Isolated fixture command approved by test operator",
		);
		approved = true;
	}
	const run = state.environments.runs.find(
		(run) => run.owner === id && run.state === "running",
	);
	if (
		run &&
		state.reviews.some(
			(review) =>
				review.title === "Keep crash fixture alive" &&
				review.state === "pending",
		)
	) {
		fs.writeFileSync(`${input.readyFile}.tmp`, JSON.stringify({ id, run }));
		fs.renameSync(`${input.readyFile}.tmp`, input.readyFile);
		while (true) await Bun.sleep(1000);
	}
	await Bun.sleep(10);
}
throw new Error("Crash-test host did not reach its held environment");
