/** @jsxImportSource @opentui/solid */
// Disposable native-renderer acceptance probe. No host, provider, Pi session or
// user configuration. Run with bun --preload @opentui/solid/preload.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Review } from "../src/state.ts";
import type { ClientConnection } from "../src/tui/client/connection.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "v2-human-ui-"));
const original = {
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
Object.assign(process.env, {
	HOME: sandbox,
	XDG_CONFIG_HOME: path.join(sandbox, "config"),
	PI_CODING_AGENT_DIR: path.join(sandbox, "pi"),
});
const { testRender, useRenderer } = await import("@opentui/solid");
const { createDefaultOpenTuiKeymap } = await import("@opentui/keymap/opentui");
const { KeymapProvider } = await import("@opentui/keymap/solid");
const { SyntaxStyle } = await import("@opentui/core");
const { createSignal, onCleanup, Show } = await import("solid-js");
const { HumanContext } = await import(
	"../src/tui/features/sessions/human-context.ts"
);
const { ToolCard } = await import("../src/tui/features/sessions/ToolCard.tsx");
const { questionReceipt } = await import("../src/questions.ts");
const { prepareReviewSubmission } = await import("../src/review-feedback.ts");
const { digest } = await import("../src/config.ts");
const { HelpText } = await import("../src/tui/ui/components/HelpText.tsx");
const { keyLabel } = await import("../src/tui/ui/keybinds.ts");
const questions = [
	{
		header: "Design",
		question: "Which design?",
		options: [
			{
				label: "Minimal",
				description: "Small implementation",
				recommended: true,
				preview: "```ts\nconst minimal = true;\n```\n\n+---+\n| A |\n+---+",
			},
			{
				label: "Expanded",
				description: "Larger implementation",
				preview: "```yaml\nexpanded: true\n```",
			},
		],
	},
	{
		header: "Capabilities",
		question: "Which capabilities?",
		multiSelect: true,
		options: [
			{ label: "Read", description: "Read files" },
			{ label: "Write", description: "Write files" },
		],
	},
	{
		header: "Extras",
		question: "Anything else?",
		multiSelect: true,
		options: [
			{ label: "Logs", description: "Collect logs" },
			{ label: "Traces", description: "Collect traces" },
		],
	},
];
const patch =
	"diff --git a/src/core/old.ts b/src/core/new.ts\nrename from src/core/old.ts\nrename to src/core/new.ts\n--- a/src/core/old.ts\n+++ b/src/core/new.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n kept\n";
const base = {
	taskId: 1,
	topicId: "probe",
	path: ".",
	state: "pending" as const,
	comments: "",
	revision: 1,
	createdAt: 0,
	conversationId: 1,
	nativeToolTaskId: 2,
	ownerKind: "conversation" as const,
};
const question: Review = {
	...base,
	id: "review-question",
	callId: "call-question",
	title: "Design questions",
	kind: "question",
	questions,
	snapshot: JSON.stringify(questions),
	digest: digest(JSON.stringify(questions)),
};
const review: Review = {
	...base,
	id: "review-code",
	callId: "call-code",
	title: "Review immutable patch",
	kind: "code-review",
	snapshot: patch,
	digest: digest(patch),
	baseCommit: "a".repeat(40),
};
const [requests, setRequests] = createSignal([question, review]);
const [current, setCurrent] = createSignal(question.id);
const [active, setActive] = createSignal<string | null>(null);
const [catalog, setCatalog] = createSignal<
	import("../src/tui/ui/keybinds.ts").Keybind[]
>([]);
const [fresh, setFresh] = createSignal(true);
const [anchored, setAnchored] = createSignal(true);
const drafts = new Map<
	string,
	{ digest: string; version: number; content: string }
>();
let failDraftRead = true;
const questionAck = Promise.withResolvers<void>(),
	questionReturned = Promise.withResolvers<void>();
const submissions: Array<
	| ReturnType<typeof questionReceipt>
	| ReturnType<typeof prepareReviewSubmission>
> = [];
const fake = {
	call: async (method: string, input: Record<string, unknown>) => {
		const r = requests().find((r) => r.id === input.id);
		assert(r);
		if (method === "human.read") {
			if (!fresh()) throw new Error("Offline fixture");
			return r;
		}
		if (method === "human.draft.read" && failDraftRead) {
			failDraftRead = false;
			throw new Error("Initial draft read unavailable");
		}
		if (method === "human.draft.read")
			return drafts.get(r.id) ?? { digest: r.digest, version: 0, content: "" };
		if (method === "human.draft.save") {
			const d = {
				digest: r.digest,
				version: Number(input.version) + 1,
				content: String(input.content),
			};
			drafts.set(r.id, d);
			return d;
		}
		if (method === "question.submit") {
			const receipt = questionReceipt(r.questions ?? [], input as never);
			submissions.push(receipt);
			setRequests((all) =>
				all.map((v) =>
					v.id === r.id
						? { ...v, state: "answered", revision: 2, answerReceipt: receipt }
						: v,
				),
			);
			await questionAck.promise;
			questionReturned.resolve();
			return receipt;
		}
		if (method === "review.submit") {
			const receipt = prepareReviewSubmission(r, input as never);
			submissions.push(receipt);
			setRequests((all) =>
				all.map((v) =>
					v.id === r.id
						? {
								...v,
								state: receipt.decision,
								revision: 2,
								receipt,
								comments: receipt.comments.map((c) => c.body).join("\n"),
							}
						: v,
				),
			);
			return receipt;
		}
		throw new Error(`Unexpected ${method}`);
	},
} as unknown as ClientConnection;
const logs: string[] = [];
const t = await testRender(
	() => {
		const renderer = useRenderer();
		const keymap = createDefaultOpenTuiKeymap(renderer);
		const syntax = SyntaxStyle.fromStyles(
			{ default: { fg: "#ffffff" } },
			renderer.nativeScene,
		);
		onCleanup(() => syntax.destroy());
		return (
			<KeymapProvider keymap={keymap}>
				<HumanContext.Provider
					value={{
						requests,
						client: fake,
						fresh,
						active,
						focus: setActive,
						catalog: setCatalog,
						register: () => () => {},
					}}
				>
					<box height="100%" flexDirection="column">
						<scrollbox flexGrow={1}>
							<Show when={current()} keyed>
								{(id) => (
									<ToolCard
										identity={id}
										scope={id}
										interactive={true}
										selected={false}
										select={() => {}}
										anchor={() => {}}
										call={{
											id: id === question.id ? question.callId : review.callId,
											name:
												id === question.id
													? "ask_user_question"
													: "request_review",
											arguments: {},
										}}
										progress={{
											callId:
												id === question.id
													? (question.callId ?? "")
													: (review.callId ?? ""),
											name: "human",
											status: "running",
										}}
										result={null}
										humanAnchor={anchored()}
										pairing="missing"
										expanded={[]}
										toggle={() => {}}
										syntax={syntax}
									/>
								)}
							</Show>
						</scrollbox>
						<HelpText
							entries={catalog()
								.filter((b) => !b.standard)
								.map((b) => ({ ...b, key: keyLabel(b.key) }))}
						/>
					</box>
				</HumanContext.Provider>
			</KeymapProvider>
		);
	},
	{ width: 170, height: 58, kittyKeyboard: true },
);
const frame = () => t.captureCharFrame();
const save = (name: string) => logs.push(`\n--- ${name} ---\n${frame()}`);
const click = async (label: string) => {
	await t.flush();
	const lines = frame().split("\n");
	const y = lines.findIndex((line) => line.includes(label));
	assert(y >= 0, `Missing mouse target ${label}\n${frame()}`);
	await t.mockMouse.click((lines[y] ?? "").indexOf(label) + 2, y);
	await t.flush();
};
const key = async (name: string, options: Record<string, boolean> = {}) => {
	if (name === "RETURN") t.mockInput.pressEnter(options);
	else if (name === "UP" || name === "DOWN")
		t.mockInput.pressArrow(name === "UP" ? "up" : "down", options);
	else if (name === "SPACE") t.mockInput.pressKey(" ", options);
	else if (["TAB", "ESCAPE"].includes(name) || name.length === 1)
		t.mockInput.pressKey(name, options);
	else for (const character of name) t.mockInput.pressKey(character);
	await t.flush();
};
try {
	await t.flush();
	await t.flush();
	assert(frame().includes("Awaiting you"));
	assert.equal(active(), null, "arrival must not focus the questionnaire");
	assert.equal(
		frame().split("Design questions").length - 1,
		1,
		"one inline card at the requesting tool",
	);
	await click("Retry draft persistence");
	await t.flush();
	setAnchored(false);
	await t.flush();
	assert(frame().includes("ambiguous requesting call identity"));
	assert(!frame().includes("Focus questionnaire"));
	assert.equal(submissions.length, 0);
	setAnchored(true);
	await t.flush();
	await t.flush();
	await click("Focus questionnaire");
	await key("DOWN");
	save("after question focus and down");
	assert(
		frame().includes("expanded: true"),
		`highlight changes the artifact preview\n${frame()}\nactive=${active()}`,
	);
	assert.equal(submissions.length, 0, "highlight never submits");
	save("wide preview, highlighted but unanswered");
	assert(frame().includes("Enter select"));
	assert(
		!frame().includes("Previous option"),
		"ordinary navigation stays out of footer",
	);
	t.resize(76, 58);
	await t.flush();
	save("narrow stacked preview");
	assert(frame().includes("expanded: true"));
	await key("UP");
	assert(frame().includes("+---+"), "ASCII artifact remains monospaced");
	t.resize(170, 58);
	await t.flush();
	await key("DOWN");
	await key("DOWN");
	await key("RETURN");
	assert(frame().includes("Type something…"));
	await key("custom first line");
	await key("RETURN", { shift: true });
	await key("second line");
	save("inline multiline custom editor");
	await key("ESCAPE");
	assert(
		!frame().includes("Design (✓)"),
		"Escape preserves text without selecting a new custom answer",
	);
	assert(frame().includes("custom first line"));
	save("Escape retains custom text without answering");
	setFresh(false);
	await t.flush();
	await t.flush();
	assert(frame().includes("controls disabled"));
	save("cached request · read-only while disconnected");
	assert.equal(submissions.length, 0);
	await key("ESCAPE");
	assert.equal(active(), null, "Escape can postpone a stale cached request");
	setFresh(true);
	await t.flush();
	await t.flush();
	await click("Design questions");
	await click("Focus questionnaire");
	await key("RETURN");
	assert(frame().includes("custom first line"));
	assert(frame().includes("second line"));
	await key("RETURN");
	await key("TAB");
	await key("RETURN");
	await key("DOWN");
	await key("SPACE");
	assert(frame().includes("☑"), "multi-select uses actual checked state");
	await key("DOWN");
	await key("RETURN");
	await key("Retained supplement");
	await key("ESCAPE");
	assert(
		frame().includes("☐ 3. Type something"),
		"Escape retains multi custom text without checking it",
	);
	await key("RETURN");
	await key("RETURN");
	await key("n");
	await key("note");
	await key("ESCAPE");
	await key("TAB");
	await key("DOWN");
	await key("DOWN");
	await key("RETURN");
	await key("Custom-only detail");
	await key("RETURN", { shift: true });
	await key("Preserved after replay");
	await key("RETURN");
	await key("TAB");
	assert(frame().includes("Review your answers"));
	assert(catalog().some((b) => b.action.includes("notes")));
	await key("n");
	await key("Overall note");
	await key("RETURN");
	await key("?");
	assert(frame().includes("Human interaction keybindings"));
	assert(frame().includes("Previous option"));
	save("question keybind help");
	await key("ESCAPE");
	await key("RETURN");
	save("after explicit answers submit");
	assert.equal(submissions.length, 1, `${frame()}\nactive=${active()}`);
	assert(frame().includes("Human receipt"));
	const answers = submissions[0];
	assert(answers && "answers" in answers);
	assert.equal(answers.answers[0]?.kind, "custom");
	assert.equal(answers.answers[0]?.answer, "custom first line\nsecond line");
	assert.deepEqual(answers.answers[1]?.selected, ["Read", "Write"]);
	assert.equal(answers.answers[1]?.notes, "note");
	assert.equal(answers.answers[1]?.answer, "Retained supplement");
	assert.deepEqual(answers.answers[2]?.selected, []);
	assert.equal(
		answers.answers[2]?.answer,
		"Custom-only detail\nPreserved after replay",
	);
	assert.equal(answers.globalNote, "Overall note");
	setCurrent(review.id);
	await t.flush();
	await t.flush();
	assert(frame().includes("src/"));
	assert(frame().includes("core/"));
	assert(frame().includes("R new.ts"));
	save("grouped immutable file tree");
	await click("R new.ts");
	assert.equal(active(), review.id);
	questionAck.resolve();
	await questionReturned.promise;
	await t.flush();
	assert.equal(
		active(),
		review.id,
		"a late acknowledgement cannot blur another card",
	);
	assert(
		catalog().some((b) => b.cmd === "human.comment"),
		"the new card keeps its keybind catalog",
	);
	save("late question acknowledgement preserves current diff focus");
	assert(frame().includes("new.ts"));
	assert(frame().includes("s split") && frame().includes("o side"));
	assert(!frame().includes("Finish"));
	assert(!frame().includes("Toggle finding"));
	save("byte-identical native DiffReviewView · controller-owned modal footer");
	await key("?");
	assert(frame().includes("Toggle old / new comment side"));
	save("diff controller footer and complete help");
	await key("ESCAPE");
	await key("s");
	await key("v");
	await key("j");
	await key("j");
	await key("c");
	save("range comment editor");
	assert(frame().includes("Draft comment"), frame());
	await key("Fix this line");
	await key("RETURN", { ctrl: true });
	await key("ESCAPE");
	save("after draft comment and diff close");
	assert(frame().includes("Submit 1 comments"), frame());
	assert(frame().includes("Fix this line"), frame());
	await click("R new.ts");
	await key("e");
	assert(frame().includes("Draft comment"));
	await key("Amended: ");
	await key("RETURN", { ctrl: true });
	await key("o");
	await key("o");
	assert(frame().includes("new-side comments"));
	await key("j");
	await key("c");
	await key("New-side feedback");
	await key("RETURN", { ctrl: true });
	await key("ESCAPE");
	assert(
		frame().includes("Amended: Fix this line"),
		"closing/reopening diff retains draft",
	);
	t.resize(76, 58);
	await t.flush();
	save("narrow file tree");
	await click("Submit 2 comments");
	assert.equal(submissions.length, 2);
	assert.equal(
		(submissions[1] as { decision: string }).decision,
		"changes-requested",
	);
	const feedback = submissions[1];
	assert(feedback && "comments" in feedback);
	const comments = feedback.comments;
	assert.equal(comments[0]?.body, "Amended: Fix this line");
	assert.equal(comments[0]?.anchor?.side, "old");
	assert.equal(comments[0]?.anchor?.start, 1);
	assert.equal(comments[0]?.anchor?.end, 2);
	assert.equal(comments[1]?.anchor?.side, "new");
	assert.equal(comments[1]?.anchor?.start, 1);
	save("immutable review receipt");
	setCurrent(question.id);
	await t.flush();
	await t.flush();
	await click("Human receipt");
	assert(frame().includes("custom first line"));
	assert(frame().includes("Read · Write"));
	assert(frame().includes("Retained supplement"));
	assert(frame().includes("Custom-only detail"));
	assert(frame().includes("Preserved after replay"));
	assert(!frame().includes('"questionIndex"'));
	save("replayed folded, readable question receipt");

	console.log(
		"Native human UI probe passed: no focus steal; narrow/wide artifact preview; multiline custom/Escape; reconnect; actual multi checkboxes; notes; footer; tabs; help; grouped tree; native diff modal; old-side range and new-side feedback; comment edit; draft reopen; inline submit; receipt.",
	);
} finally {
	questionAck.resolve();
	if (process.env.HUMAN_UI_EVIDENCE_DIR) {
		fs.mkdirSync(process.env.HUMAN_UI_EVIDENCE_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(process.env.HUMAN_UI_EVIDENCE_DIR, "native-ui.log"),
			logs.join("\n"),
		);
	}
	t.renderer.destroy();
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(sandbox, { recursive: true, force: true });
}
