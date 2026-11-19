import { expect, test } from "bun:test";
import { result } from "../src/protocol/frames.ts";
import { queuedInputs } from "../src/queued-inputs.ts";

test("queue previews preserve native identity, order, mode and text without placing inputs", () => {
	const items = [
		{
			id: 8,
			mode: "followUp" as const,
			content: "Check this next 😀e\u0301\r\n",
		},
		{
			id: 9,
			mode: "steer" as const,
			content: [
				{ type: "text", text: "Change direction" },
				{ type: "image", data: "private-image-bytes" },
			],
		},
	];
	const original = JSON.stringify(items);
	expect(queuedInputs(items)).toEqual([
		{ id: 8, mode: "followUp", content: items[0].content, truncated: false },
		{
			id: 9,
			mode: "steer",
			content: "Change direction\n[image]",
			truncated: false,
		},
	]);
	expect(JSON.stringify(queuedInputs(items))).not.toContain(
		"private-image-bytes",
	);
	expect(JSON.stringify(items)).toBe(original);
	// Native placement/draining removes the notice, without a local shadow queue.
	expect(queuedInputs(items.slice(1)).map((item) => item.id)).toEqual([9]);
	expect(queuedInputs([])).toEqual([]);
});

test("queue content previews are bounded without dropping queued submission identities", () => {
	const previews = queuedInputs(
		Array.from({ length: 40 }, (_, id) => ({
			id,
			mode: "followUp" as const,
			content: "x".repeat(64000),
		})),
	);
	expect(previews).toHaveLength(40);
	expect(previews[0]).toMatchObject({
		content: "x".repeat(2048),
		truncated: true,
	});
	expect(
		previews.reduce((size, item) => size + (item.content?.length ?? 0), 0),
	).toBeLessThanOrEqual(32768);
	expect(previews[39]).toMatchObject({ id: 39, content: "", truncated: true });
});

test("submission acknowledgements validate the optional observed queue state", () => {
	expect(result("session.send", { submissionId: 8, queued: true })).toEqual({
		submissionId: 8,
		queued: true,
	});
	expect(result("session.send", { submissionId: 8 })).toEqual({
		submissionId: 8,
	});
	expect(() =>
		result("session.send", { submissionId: 8, queued: "yes" }),
	).toThrow("Invalid submission queue observation");
});
