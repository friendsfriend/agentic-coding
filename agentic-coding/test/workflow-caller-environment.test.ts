import { describe, expect, test } from "bun:test";
import {
	type CallerEnvironment,
	linuxCallerEnvironment,
} from "../src/workflow/cli/caller-environment.ts";

const launch: CallerEnvironment = {
	HERDR_WORKFLOW_ID: "sidebar",
	HERDR_RUN_ID: "planner-1",
	HERDR_STEP_ID: "core.plan",
	HERDR_ROLE: "planner",
	HERDR_RUN_TOKEN: "test-run-capability",
};

function ancestry(
	options: {
		host?: boolean;
		ancestor?: CallerEnvironment;
		unreadable?: number;
		cycle?: boolean;
	} = {},
) {
	return {
		environment: (pid: number): CallerEnvironment => {
			if (pid === options.unreadable) throw new Error("EACCES");
			return pid === 20 ? (options.ancestor ?? {}) : {};
		},
		parent: (pid: number): number | undefined => {
			if (pid === 30) return 20;
			if (pid === 20) return options.cycle ? 30 : 10;
			if (pid === 10) return 1;
			return undefined;
		},
		command: (pid: number) =>
			pid === 20 && options.host !== false
				? "/opt/agentic-coding agent host --workflow-dir /tmp/workflow"
				: "shell",
	};
}

describe("Linux managed caller environment", () => {
	test("durable host children use their own per-run environment", () => {
		expect(linuxCallerEnvironment(launch, 30, ancestry())).toEqual(launch);
	});

	test("separate runs under a shared host retain separate identities", () => {
		const other = {
			...launch,
			HERDR_RUN_ID: "worker-2",
			HERDR_RUN_TOKEN: "other",
		};
		expect(linuxCallerEnvironment(other, 30, ancestry())).toEqual(other);
		expect(linuxCallerEnvironment(launch, 30, ancestry())).toEqual(launch);
	});

	test("a durable child cannot clear credentials to become an operator", () => {
		expect(() => linuxCallerEnvironment({}, 30, ancestry())).toThrow(
			"managed caller ancestry is unavailable",
		);
	});

	test("legacy launch-bound ancestor credentials take precedence", () => {
		expect(
			linuxCallerEnvironment(
				{ ...launch, HERDR_RUN_TOKEN: "overridden" },
				30,
				ancestry({ host: false, ancestor: launch }),
			),
		).toEqual(launch);
		expect(
			linuxCallerEnvironment(
				{},
				30,
				ancestry({ host: false, ancestor: launch }),
			),
		).toEqual(launch);
	});

	test("local credentials alone are not proof of managed ancestry", () => {
		expect(() =>
			linuxCallerEnvironment(launch, 30, ancestry({ host: false })),
		).toThrow("managed caller ancestry is unavailable");
	});

	test("ordinary operator ancestry remains interactive", () => {
		expect(linuxCallerEnvironment({}, 30, ancestry({ host: false }))).toEqual(
			{},
		);
	});

	test("unreadable ancestry fails closed without established identity", () => {
		expect(() =>
			linuxCallerEnvironment(
				launch,
				30,
				ancestry({ host: false, unreadable: 20 }),
			),
		).toThrow("managed caller ancestry is unavailable");
	});

	test("an unreadable outer ancestor does not discard durable identity", () => {
		expect(
			linuxCallerEnvironment(launch, 30, ancestry({ unreadable: 10 })),
		).toEqual(launch);
		expect(() =>
			linuxCallerEnvironment({}, 30, ancestry({ unreadable: 10 })),
		).toThrow("managed caller ancestry is unavailable");
	});

	test("cyclic ancestry is rejected even with local credentials", () => {
		expect(() =>
			linuxCallerEnvironment(launch, 30, ancestry({ cycle: true })),
		).toThrow("managed caller ancestry is cyclic");
	});
});
