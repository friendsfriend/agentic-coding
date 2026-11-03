import { expect, test } from "bun:test";
import {
	type Candidate,
	defaultTargets,
	selectTarget,
} from "../src/environment/selection.ts";

test("tool selection and advertised defaults share profile, ambiguity and explicit-runtime rules", () => {
	const targets: Candidate[] = [
		{ id: "local", action: "run", runtime: "shell" },
		{ id: "container", action: "run", runtime: "docker", label: "Development" },
		{ id: "alternative", action: "run", runtime: "podman", label: "local" },
		{ id: "ci", action: "build", runtime: "docker", profile: "ci" },
		{ id: "build-a", action: "build", runtime: "shell" },
		{ id: "build-b", action: "build", runtime: "docker" },
		{ id: "cluster-a", action: "run", runtime: "kubernetes" },
		{ id: "cluster-b", action: "run", runtime: "kubernetes" },
	];
	expect(defaultTargets(targets).run).toEqual({
		id: "container",
		reason: "runtime-preference",
	});
	expect(selectTarget(targets, "run", { target: "local" }).runtime).toBe(
		"shell",
	);
	expect(selectTarget(targets, "run", { target: "Development" }).id).toBe(
		"container",
	);
	expect(
		selectTarget(targets, "run", { runtime: "podman" }, "container").id,
	).toBe("alternative");
	expect(defaultTargets(targets, { build: "ci" }).build).toEqual({
		id: "ci",
		reason: "declared",
	});
	expect(() => selectTarget(targets, "build")).toThrow("unambiguous");
	expect(() =>
		selectTarget(
			targets.filter((item) => item.id === "ci"),
			"build",
		),
	).toThrow("none");
	expect(() => selectTarget(targets, "run", {}, "cluster-a")).toThrow(
		"explicit runtime",
	);
	expect(() => selectTarget(targets, "run", { runtime: "kubernetes" })).toThrow(
		"cluster-a, cluster-b",
	);
	expect(
		selectTarget(targets, "run", { target: "cluster-a", replicas: 2 }).id,
	).toBe("cluster-a");
	expect(() =>
		selectTarget(targets, "run", { target: "local", replicas: 2 }),
	).toThrow("replicas-unsupported");
});
