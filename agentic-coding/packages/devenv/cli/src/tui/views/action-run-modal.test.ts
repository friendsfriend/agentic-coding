import { describe, expect, test } from "bun:test";
import type { ActionRun } from "@devenv/types";
import {
	actionModalHelpText,
	actionNodeAnimationEnabled,
	actionNodeStep,
} from "./action-run-modal";

const gitPull: ActionRun = {
	id: "pull-1",
	title: "Git pull api",
	action: "git.pull",
	status: "completed",
	steps: [
		{
			id: "git:api",
			label: "Git pull api",
			status: "completed",
			commands: [
				{
					id: "fetch",
					command: "git fetch origin",
					status: "completed",
					stdout: "updated\n",
					stderr: "",
					exitCode: 0,
				},
			],
		},
	],
};

describe("action run modal", () => {
	test("shows only focused panel bindings", () => {
		expect(actionModalHelpText(0).map((entry) => entry.key)).toContain("n/p");
		expect(actionModalHelpText(0).map((entry) => entry.key)).not.toContain(
			"d/u",
		);
		expect(actionModalHelpText(1).map((entry) => entry.key)).toContain("d/u");
		expect(actionModalHelpText(1).map((entry) => entry.key)).not.toContain(
			"n/p",
		);
	});

	test("animates leaves and collapsed parents, not expanded parents", () => {
		const parent = {
			key: "step:parent",
			kind: "step" as const,
			run: gitPull,
			step: {
				id: "parent",
				label: "Parent",
				status: "completed" as const,
				commands: [],
			},
			depth: 0,
			hasChildren: true,
		};
		const leaf = {
			...parent,
			key: "step:leaf",
			step: { ...parent.step, id: "leaf" },
			hasChildren: false,
		};
		expect(actionNodeAnimationEnabled(parent, false)).toBe(false);
		expect(actionNodeAnimationEnabled(parent, true)).toBe(true);
		expect(actionNodeAnimationEnabled(leaf, false)).toBe(true);
	});

	test("shows command details when structurally single-step action row is selected", () => {
		const step = actionNodeStep({
			key: "action:pull-1",
			kind: "action",
			run: gitPull,
			depth: 0,
			hasChildren: false,
		});
		expect(step?.commands[0]).toMatchObject({
			command: "git fetch origin",
			stdout: "updated\n",
			exitCode: 0,
		});
	});
});
