import { describe, expect, test } from "bun:test";
import type { ActionRun } from "@devenv/types";
import { actionRunDisplayLabel, actionTypeLabel } from "./action-labels";

const formatProfileLabel = (profile?: string) =>
	profile?.trim() || "default (no profile)";

describe("actionTypeLabel", () => {
	test("resolves known machine action keys", () => {
		expect(actionTypeLabel("run")).toBe("Start");
		expect(actionTypeLabel("stop")).toBe("Stop");
		expect(actionTypeLabel("git.pull")).toBe("Git pull");
		expect(actionTypeLabel("kubernetes.cluster.create")).toBe(
			"Create Kubernetes cluster",
		);
	});
	test("title-cases unknown action keys as a fallback", () => {
		expect(actionTypeLabel("kubernetes.cluster.recreate")).toBe(
			"Recreate Kubernetes cluster",
		);
		expect(actionTypeLabel("something.unregistered")).toBe(
			"Something Unregistered",
		);
	});
	test("returns empty string for missing action", () => {
		expect(actionTypeLabel(undefined)).toBe("");
	});
});

describe("actionRunDisplayLabel", () => {
	const base: Pick<
		ActionRun,
		"title" | "action" | "targetLabel" | "profile" | "appIdent"
	> = {
		title: "Stop myapp",
	};

	test("prefers the server-provided title for non-targeted actions", () => {
		expect(
			actionRunDisplayLabel({ ...base, action: "stop" }, formatProfileLabel),
		).toBe("Stop myapp");
		expect(
			actionRunDisplayLabel(
				{ ...base, title: "Git pull api", action: "git.pull" },
				formatProfileLabel,
			),
		).toBe("Git pull api");
		expect(
			actionRunDisplayLabel(
				{
					...base,
					title: "Create Kubernetes cluster",
					action: "kubernetes.cluster.create",
				},
				formatProfileLabel,
			),
		).toBe("Create Kubernetes cluster");
	});

	test('composes "<Action> <target>" for targeted run/build/test actions', () => {
		expect(
			actionRunDisplayLabel(
				{ title: "Build myapp", action: "build", targetLabel: "web" },
				formatProfileLabel,
			),
		).toBe("Build web");
		expect(
			actionRunDisplayLabel(
				{ title: "Run myapp", action: "run", profile: "prod" },
				formatProfileLabel,
			),
		).toBe("Start prod");
	});

	test("falls back to action + target composition when title is missing", () => {
		expect(
			actionRunDisplayLabel(
				{ title: "", action: "stop", appIdent: "myapp" },
				formatProfileLabel,
			),
		).toBe("Stop myapp");
	});
});
