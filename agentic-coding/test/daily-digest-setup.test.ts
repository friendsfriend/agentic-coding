import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionCommand } from "../src/agent-host/session-command.ts";
import { decodeScheduling, jobSchema } from "../src/contracts/scheduling.ts";
import {
	bindDurableSession,
	createDurableSession,
	durableSessionOwner,
	initializeDurableSessions,
	readDurableSessionRegistry,
} from "../src/pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../src/pi-durable-state.ts";
import { dailyDigestProposal } from "../src/scheduling/daily-digest-setup.ts";
import { previewTiming } from "../src/scheduling/recurrence.ts";

test("nonactivated proposal validates exact defaults and Berlin weekday DST previews", () => {
	const proposal = dailyDigestProposal(
		{
			id: "fake",
			operationId: "fixture",
			owner: "uid:fake",
			name: "Daily task digest",
			runId: "pi-durable-fake",
			createdAt: 0,
			cwd: "/synthetic",
			model: "fake/model",
			thinking: "low",
			toolPolicy: "collection",
			binding: { hostId: "fake-native", conversationId: "fake-conversation" },
		},
		"main",
	);
	expect(decodeScheduling(jobSchema, proposal.job)).toEqual(proposal.job);
	expect(() =>
		decodeScheduling(jobSchema, {
			...proposal.job,
			target: {
				...proposal.job.target,
				policy: "default",
				reviewPolicy: "human",
			},
		}),
	).toThrow();
	expect(proposal.confirmationRequired.join(" ")).toContain("Monday");
	expect(proposal.schedule.latePolicy.kind).toBe("run-late");
	const spring = previewTiming(
		proposal.schedule.timing,
		Date.parse("2026-03-27T07:59:00Z"),
	);
	expect(spring.next[0]?.at).toBe("2026-03-27T08:00:00Z");
	expect(spring.next[1]?.at).toBe("2026-03-30T07:00:00Z");
	const autumn = previewTiming(
		proposal.schedule.timing,
		Date.parse("2026-10-23T06:59:00Z"),
	);
	expect(autumn.next[0]?.at).toBe("2026-10-23T07:00:00Z");
	expect(autumn.next[1]?.at).toBe("2026-10-26T08:00:00Z");
});
test("supported session command creates only through the lifecycle and proposal never starts a host or schedule", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-command-"));
	try {
		const output: string[] = [],
			runtimeDir = piDurableRuntimeDir(root),
			owner = durableSessionOwner();
		initializeDurableSessions(runtimeDir, root, owner);
		let opens = 0;
		const dependencies = {
			configDir: root,
			print: (value: string) => output.push(value),
			models: async () => ["fake/model"],
			open: async () => {
				opens++;
				return {
					runId: "pi-durable-fake",
					sessionId: "fake",
					hostSocket: "fake",
				};
			},
		};
		expect(
			await sessionCommand(
				[
					"create",
					"--name",
					"Daily task digest",
					"--cwd",
					root,
					"--model",
					"fake/model",
					"--thinking",
					"low",
					"--operation-id",
					"fake",
					"--collection",
				],
				dependencies,
			),
		).toBe(0);
		expect(opens).toBe(1);
		const record = createDurableSession(runtimeDir, {
			operationId: "fake-bound",
			name: "Daily task digest",
			owner,
			cwd: root,
			model: "fake/model",
			thinking: "low",
			toolPolicy: "collection",
		});
		bindDurableSession(runtimeDir, record.id, owner, {
			hostId: "fake",
			conversationId: "fake-native",
		});
		const before = JSON.stringify(readDurableSessionRegistry(runtimeDir));
		expect(
			await sessionCommand(
				["digest-proposal", record.id, "--base-branch", "main"],
				dependencies,
			),
		).toBe(0);
		expect(opens).toBe(1);
		expect(JSON.stringify(readDurableSessionRegistry(runtimeDir))).toBe(before);
		expect(fs.existsSync(path.join(root, "scheduling"))).toBe(false);
		expect(output.at(-1)).toContain("workflowless-session");
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});
