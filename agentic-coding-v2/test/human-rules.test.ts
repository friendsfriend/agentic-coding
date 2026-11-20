import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
	type Question,
	questionReceipt,
	validateQuestions,
} from "../src/questions.ts";
import {
	gitPatchPath,
	reviewFiles,
	reviewFileTree,
} from "../src/review-files.ts";
import type { Review } from "../src/state.ts";
import type { ClientConnection } from "../src/tui/client/connection.ts";
import {
	createHumanDraft,
	decodeHumanDraft,
	emptyHumanDraft,
} from "../src/tui/features/sessions/human-draft.ts";
import { keyLabel } from "../src/tui/ui/keybinds.ts";

const questions: Question[] = [
	{
		header: "One",
		question: "Which one?",
		options: [
			{ label: "A", description: "First", preview: "```ts\nA()\n```" },
			{ label: "B", description: "Second" },
		],
	},
	{
		header: "Many",
		question: "Which capabilities?",
		multiSelect: true,
		options: [
			{ label: "Read", description: "Read files" },
			{ label: "Write", description: "Edit files" },
		],
	},
];
test("question submission preserves single/custom/multi answers and notes without treating highlights or notes as answers", () => {
	validateQuestions(questions);
	const input = {
		id: "review-1",
		revision: 1,
		digest: "snapshot",
		requestId: "answers",
		answers: [
			{ optionIndexes: [0], text: "", notes: "Specific note" },
			{ optionIndexes: [1, 0], text: "Also test", notes: "" },
		],
		globalNote: "Global note",
	};
	const receipt = questionReceipt(questions, input);
	expect(receipt.answers[0]).toMatchObject({
		kind: "option",
		answer: "A",
		preview: questions[0]?.options[0]?.preview,
		notes: "Specific note",
	});
	expect(receipt.answers[1]).toMatchObject({
		kind: "multi",
		selected: ["Read", "Write"],
		answer: "Also test",
	});
	expect(receipt.globalNote).toBe("Global note");
	expect(
		questionReceipt(questions, {
			...input,
			answers: [
				{ optionIndexes: [], text: "Custom\nanswer", notes: "" },
				input.answers[1],
			],
		}).answers[0],
	).toMatchObject({ kind: "custom", answer: "Custom\nanswer" });
	for (const answer of [
		{ optionIndexes: [], text: "", notes: "Notes only" },
		{ optionIndexes: [0, 1], text: "", notes: "" },
		{ optionIndexes: [2], text: "", notes: "" },
	])
		expect(() =>
			questionReceipt(questions, {
				...input,
				answers: [answer, input.answers[1]],
			}),
		).toThrow();
	expect(() =>
		validateQuestions([
			{
				...questions[0],
				options: [
					{ label: "Other", description: "Reserved" },
					questions[0].options[0],
				],
			},
		]),
	).toThrow("Reserved");
});
test("immutable review file trees retain hierarchy, renames, deleted and binary identities without fabricated line anchors", () => {
	const files = reviewFiles(`diff --git a/src/old.ts b/src/nested/new.ts
similarity index 50%
rename from src/old.ts
rename to src/nested/new.ts
--- a/src/old.ts
+++ b/src/nested/new.ts
@@ -4,1 +4,2 @@
-old
+new
+extra
diff --git a/assets/image.png b/assets/image.png
new file mode 100644
GIT binary patch
literal 5
abc
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-removed
`);
	expect(
		files.map((f) => [f.status, f.oldPath, f.newPath, f.added, f.deleted]),
	).toEqual([
		["R", "src/old.ts", "src/nested/new.ts", 2, 1],
		["A", null, "assets/image.png", 0, 0],
		["D", "src/deleted.ts", null, 0, 1],
	]);
	expect(files[1]).toMatchObject({ binary: true, oldLines: [], newLines: [] });
	const tree = reviewFileTree(files);
	expect(tree.map((n) => n.name)).toEqual(["assets", "src"]);
	expect(tree[1]?.children[0]?.name).toBe("nested");
	expect(tree[1]?.children[0]?.children[0]?.file?.oldPath).toBe("src/old.ts");
	expect(gitPatchPath('"b/\\303\\244.ts"')).toBe("ä.ts");
	expect(gitPatchPath('"a/old.ts"', false)).toBe("a/old.ts");
});

test("retained draft text is recoverable but malformed saved data cannot become interactive", () => {
	const review: Review = {
		id: "draft-question",
		taskId: 1,
		topicId: "",
		path: "",
		title: "Questions",
		kind: "question",
		questions,
		snapshot: JSON.stringify(questions),
		digest: "snapshot",
		state: "pending",
		comments: "",
		revision: 1,
		createdAt: 0,
	};
	const draft = emptyHumanDraft(review);
	const first = draft.answers[0];
	if (!first) throw new Error("Missing answer fixture");
	first.text = "Retained\nnot confirmed";
	first.customSelected = false;
	expect(
		decodeHumanDraft(JSON.stringify(draft), review).answers[0],
	).toMatchObject({
		text: first.text,
		customSelected: false,
		optionIndexes: [],
	});
	expect(() =>
		decodeHumanDraft(
			JSON.stringify({ ...draft, answers: [null, ...draft.answers.slice(1)] }),
			review,
		),
	).toThrow("not overwritten");
});
test("key labels distinguish shifted letters without losing real modifier combinations", () => {
	expect(keyLabel("n")).toBe("n");
	expect(keyLabel("shift+n")).toBe("N");
	expect(keyLabel("ctrl+shift+c")).toBe("Ctrl+Shift+C");
});

test("draft persistence keeps the newest in-flight edit and retains local text on a save conflict", async () => {
	const review: Review = {
		id: "draft-save",
		taskId: 1,
		topicId: "",
		path: "",
		title: "Draft",
		kind: "question",
		questions,
		snapshot: JSON.stringify(questions),
		digest: "snapshot",
		state: "pending",
		comments: "",
		revision: 1,
		createdAt: 0,
	};
	type Saved = { digest: string; version: number; content: string };
	let persisted: Saved = { digest: review.digest, version: 0, content: "" };
	const read = Promise.withResolvers<Saved>(),
		first = Promise.withResolvers<void>(),
		latestSaved = Promise.withResolvers<void>(),
		conflictEntered = Promise.withResolvers<void>(),
		conflict = Promise.withResolvers<Saved>();
	const client = {
		call: (method: string, input: { version?: number; content?: string }) => {
			if (method === "human.draft.read") return read.promise;
			if (method !== "human.draft.save" || typeof input.content !== "string")
				throw new Error("Unexpected draft request");
			if (input.version !== persisted.version)
				return Promise.reject(new Error("Draft version conflict"));
			const content = input.content,
				note = JSON.parse(content).globalNote;
			const save = () => {
				persisted = {
					digest: review.digest,
					version: persisted.version + 1,
					content,
				};
				return persisted;
			};
			if (note === "first") return first.promise.then(save);
			if (note === "latest") {
				const result = save();
				latestSaved.resolve();
				return Promise.resolve(result);
			}
			conflictEntered.resolve();
			return conflict.promise;
		},
	} as unknown as ClientConnection;
	let dispose = () => {};
	const draft = createRoot((end) => {
		dispose = end;
		return createHumanDraft(client, review);
	});
	try {
		draft.retry();
		read.resolve(persisted);
		await read.promise;
		expect(draft.ready()).toBe(true);
		draft.change((d) => ({ ...d, globalNote: "first" }));
		draft.change((d) => ({ ...d, globalNote: "latest" }));
		first.resolve();
		await latestSaved.promise;
		expect(JSON.parse(persisted.content).globalNote).toBe("latest");
		draft.change((d) => ({ ...d, globalNote: "local after conflict" }));
		await conflictEntered.promise;
		conflict.reject(new Error("Draft version conflict"));
		await conflict.promise.catch(() => {});
		expect(draft.value().globalNote).toBe("local after conflict");
		expect(draft.error()).toContain("Draft version conflict");
		expect(draft.error()).toContain("local draft retained");
		expect(JSON.parse(persisted.content).globalNote).toBe("latest");
	} finally {
		first.resolve();
		conflict.resolve(persisted);
		dispose();
	}
});
