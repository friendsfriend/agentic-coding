import { expect, test } from "bun:test";
import {
	boundedLiveOutput,
	createProgressPublisher,
	LIVE_TOOL_OUTPUT_CHARS,
} from "../src/agent-host/progress-publisher.ts";

test("a slow progress writer coalesces a burst before copying snapshots", async () => {
	let value = 0;
	let snapshots = 0;
	let release: (() => void) | undefined;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const writes: number[] = [];
	const timers = new Map<number, () => void>();
	let id = 0;
	const progress = createProgressPublisher(
		() => {
			snapshots++;
			return value;
		},
		async (snapshot) => {
			writes.push(snapshot);
			if (writes.length === 1) await blocked;
		},
		{
			now: () => 0,
			setTimer: (run) => {
				const key = ++id;
				timers.set(key, run);
				return key;
			},
			clearTimer: (key) => {
				timers.delete(Number(key));
			},
		},
	);
	progress.request();
	await Promise.resolve();
	for (value = 1; value <= 1000; value++) progress.request();
	value = 1000;
	expect(snapshots).toBe(1);
	expect(writes).toEqual([0]);
	release?.();
	await progress.flush();
	expect(writes).toEqual([0, 1000]);
	expect(snapshots).toBe(2);
	progress.dispose();
	expect(timers.size).toBe(0);
});

test("progress respects its cadence, disposes timers, and surfaces write errors", async () => {
	let time = 0;
	let timer: (() => void) | undefined;
	const writes: number[] = [];
	const progress = createProgressPublisher(
		() => time,
		async (value) => {
			writes.push(value);
		},
		{
			now: () => time,
			windowMs: 50,
			setTimer: (run) => {
				timer = run;
				return 1;
			},
			clearTimer: () => {
				timer = undefined;
			},
		},
	);
	progress.request();
	await progress.flush();
	time = 10;
	progress.request();
	expect(writes).toEqual([0]);
	time = 50;
	timer?.();
	await progress.flush();
	expect(writes).toEqual([0, 50]);
	time = 60;
	progress.request();
	progress.dispose();
	expect(timer).toBeUndefined();
	progress.request();
	await progress.flush();
	expect(writes).toEqual([0, 50]);
	const broken = createProgressPublisher(
		() => 1,
		async () => {
			throw new Error("write failed");
		},
	);
	broken.request();
	await expect(broken.flush()).rejects.toThrow("write failed");
	broken.dispose();
});

test("live tool output retains a bounded tail without splitting surrogate pairs", () => {
	let text = "";
	for (let index = 0; index < 100; index++)
		text = boundedLiveOutput(text, "x".repeat(10_000)).text;
	expect(text.length).toBe(LIVE_TOOL_OUTPUT_CHARS);
	const tail = boundedLiveOutput(text, "😀last");
	expect(tail.truncated).toBe(true);
	expect(tail.text).toEndWith("😀last");
	expect(tail.text.length).toBeLessThanOrEqual(LIVE_TOOL_OUTPUT_CHARS);
	const unicode = boundedLiveOutput("", "😀".repeat(LIVE_TOOL_OUTPUT_CHARS));
	expect(unicode.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
});
