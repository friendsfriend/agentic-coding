import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server/index.ts";
import { Catalog, decode, type Review } from "../src/state.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { emptyHumanDraft } from "../src/tui/features/sessions/human-draft.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
async function pending(app: Runtime, title: string): Promise<Review> {
	const watch = await app.harness.watchDoc(Catalog, context);
	if (!watch) throw new Error("Missing catalog");
	const match = (reviews: Record<string, string>) =>
		Object.values(reviews)
			.map((raw) => decode<Review>(raw))
			.find((r) => r.title === title && r.state === "pending");
	try {
		const initial = watch.value && match(watch.value.reviews);
		if (initial) return initial;
		return await new Promise<Review>((resolve, reject) => {
			watch.start(async (call) => {
				if (call.kind === "value" && !call.retired) {
					const value = match(call.value.reviews);
					if (value) resolve(value);
				}
			});
			void watch.closed.then(() => reject(new Error("Catalog watch ended")));
		});
	} finally {
		await watch.stop();
	}
}
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, JSON.parse(JSON.stringify(args))), {
		stopReason: "toolUse",
	});

test("durable human requests survive restart, acknowledge authenticated feedback once and never weaken explicit gates", async () => {
	const fixtureState = await fixture(true);
	let app = fixtureState.app;
	const { fake, invocation, open } = fixtureState;
	let continueModel = () => {};
	const continuation = new Promise<void>((resolve) => {
		continueModel = resolve;
	});
	const questions = [
		{
			header: "Design",
			question: "Which design?",
			options: [
				{
					label: "Small",
					description: "Minimal",
					preview: "```ts\nconst small = true;\n```",
				},
				{ label: "Large", description: "More scope" },
			],
		},
	];
	fake.setResponses([
		call("ask_user_question", { questions }),
		call("schedule_skill", {
			id: "must-not-run",
			invocation,
			timing: { kind: "interval", everyMs: 60000, anchor: Date.now() },
			lateGraceMs: null,
		}),
		call("request_review", { path: ".", title: "No feedback" }),
		call("request_review", { path: ".", title: "With feedback" }),
		async (transcript) => {
			expect(JSON.stringify(transcript.messages)).toContain(
				"Please explain the change",
			);
			expect(JSON.stringify(transcript.messages)).toContain("Human note");
			await continuation;
			return fauxAssistantMessage("Human feedback received");
		},
		fauxAssistantMessage("Queued conversation is not a human decision"),
	]);
	let host = serve(app),
		client = new ClientConnection(host.client);
	const connect = async () => {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
	};
	try {
		await connect();
		await client.call("session.send", {
			id: Number(app.home.id),
			content: "Ask the human",
			requestId: "start-human",
		});
		const question = await pending(app, "Design");
		expect(question.ownerKind).toBe("conversation");
		await client.call("session.send", {
			id: Number(app.home.id),
			content: "This chat is not an answer",
			requestId: "not-an-answer",
		});
		expect((await client.call("human.read", { id: question.id })).state).toBe(
			"pending",
		);
		const retained = emptyHumanDraft(question);
		const first = retained.answers[0];
		if (!first) throw new Error("Missing draft fixture");
		first.text = "retained but not submitted";
		const saved = await client.call("human.draft.save", {
			id: question.id,
			digest: question.digest,
			version: 0,
			content: JSON.stringify(retained),
		});
		client.close();
		await host.stop();
		await app.close();
		app = await open();
		host = serve(app);
		client = new ClientConnection(host.client);
		await connect();
		expect(await client.call("human.draft.read", { id: question.id })).toEqual(
			saved,
		);
		expect((await pending(app, "Design")).id).toBe(question.id);
		const answers = {
			id: question.id,
			revision: question.revision,
			digest: question.digest,
			requestId: "answers",
			answers: [{ optionIndexes: [0], text: "", notes: "Human note" }],
			globalNote: "Global note",
		};
		await expect(
			client.call("question.submit", { ...answers, answers: [] }),
		).rejects.toThrow("Invalid questionnaire");
		// One socket can be waiting on unrelated model work and still deliver
		// authenticated human input. Gate only the external standalone boundary.
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const sending = spyOn(app.standalone, "send").mockImplementation(
			async () => {
				entered.resolve();
				await release.promise;
				throw new Error("Fixture standalone finished");
			},
		);
		const stalled = client
			.call("standalone.send", {
				id: "fixture-standalone",
				revision: 1,
				content: "Held external model",
				requestId: "held-standalone",
			})
			.catch(() => undefined);
		const answerReceipt = await (async () => {
			try {
				await entered.promise;
				return await client.call("question.submit", answers);
			} finally {
				release.resolve();
				await stalled;
				sending.mockRestore();
			}
		})();
		expect(answerReceipt.answers[0]).toMatchObject({
			kind: "option",
			answer: "Small",
			notes: "Human note",
			preview: questions[0]?.options[0]?.preview,
		});
		expect(await client.call("question.submit", answers)).toEqual(
			answerReceipt,
		);
		const gate = await pending(app, "Authorize skill schedule");
		expect(gate.kind).toBe("approval");
		await expect(
			client.call("review.submit", {
				id: gate.id,
				revision: gate.revision,
				digest: gate.digest,
				requestId: "not-code",
				comments: [],
			}),
		).rejects.toThrow("explicit approval");
		// A persisted legacy gate is recovered from the real native tool, not its title.
		await app.harness.commit(async (tx) => {
			const doc = await tx.doc(Catalog);
			const legacy = decode<Review>(doc.reviews[gate.id] ?? "");
			delete legacy.kind;
			delete legacy.callId;
			delete legacy.conversationId;
			delete legacy.nativeToolTaskId;
			delete legacy.ownerKind;
			doc.reviews[gate.id] = JSON.stringify(legacy);
		}, context);
		await app.tick();
		const recovered = await client.call("human.read", { id: gate.id });
		expect(recovered.callId).toBe(gate.callId);
		expect(recovered.state).toBe("pending");
		expect(recovered.kind).toBeUndefined();
		await client.call("approval.submit", {
			id: gate.id,
			revision: gate.revision,
			digest: gate.digest,
			requestId: "reject-gate",
			decision: "rejected",
			comments: "",
		});
		expect((await app.snapshot()).schedules).toHaveLength(0);
		const empty = await pending(app, "No feedback");
		await expect(
			client.call("review.decide", {
				id: empty.id,
				revision: empty.revision,
				decision: "approved",
				comments: "",
			}),
		).rejects.toThrow("snapshot-bound");
		const approval = await client.call("review.submit", {
			id: empty.id,
			revision: empty.revision,
			digest: empty.digest,
			requestId: "approve-code",
			comments: [{ body: " \n " }],
		});
		expect(approval.decision).toBe("approved");
		const review = await pending(app, "With feedback");
		const feedback = {
			id: review.id,
			revision: review.revision,
			digest: review.digest,
			requestId: "human-submit",
			comments: [{ body: "Please explain the change" }],
		};
		await expect(
			client.call("review.submit", { ...feedback, digest: "stale" }),
		).rejects.toThrow("snapshot identity");
		const receipt = await client.call("review.submit", feedback);
		expect(receipt.decision).toBe("changes-requested");
		// The authenticated receipt is already durable while continuation is gated.
		continueModel();
		await app.home.waitForIdle(context);
		expect(await client.call("review.submit", feedback)).toEqual(receipt);
		await expect(
			client.call("review.submit", { ...feedback, comments: [] }),
		).rejects.toThrow("reused");
		// Task-owned/nested agents share the capability and cancellation never
		// manufactures an answer. One fixture/boundary, no timer deadlines.
		fake.setResponses([
			call("ask_user_question", {
				questions: [{ ...questions[0], header: "Cancel me" }],
			}),
		]);
		const task = await app.startTask({
			...invocation,
			requestId: "cancel-question",
		});
		const cancelled = await pending(app, "Cancel me");
		expect(cancelled.ownerKind).toBe("task");
		await app.cancel(task);
		await app.harness.waitForTask(task as never, context);
		await app.tick();
		await expect(
			client.call("question.submit", {
				...answers,
				id: cancelled.id,
				digest: cancelled.digest,
				revision: cancelled.revision,
				requestId: "too-late",
			}),
		).rejects.toThrow();
		expect((await client.call("human.read", { id: cancelled.id })).state).toBe(
			"cancelled",
		);
	} finally {
		continueModel();
		client.close();
		await host.stop();
	}
});
