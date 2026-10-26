import { describe, expect, test } from "bun:test";
import {
	CommandHandler,
	type CommandSpec,
} from "../src/server/actions/command.ts";
import { Engine } from "../src/server/actions/engine.ts";
import { compileTargetGraph } from "../src/server/actions/target-compile.ts";

async function build(
	labels: unknown,
	fail?: "build" | "inspect" | "create" | "cp",
) {
	const seen: CommandSpec[] = [];
	const handler = new CommandHandler({
		run: async (spec) => {
			seen.push(spec);
			const command = spec.args[0];
			if (command === fail)
				return {
					stdout: "",
					stderr: "fixture failure",
					exitCode: 1,
					error: new Error("fixture failure"),
				};
			return {
				stdout:
					command === "inspect"
						? JSON.stringify(labels)
						: command === "create"
							? "fixture-container\n"
							: "",
				stderr: "",
				exitCode: 0,
			};
		},
	});
	const definition = compileTargetGraph(
		"document-service",
		{
			id: "build",
			action: "build",
			runtime: "docker",
			label: "Build",
			sourcePath: "/fixture/Dockerfile",
		},
		undefined,
		"/fixture/checkout",
		undefined,
		{ sourceExists: () => true },
	);
	const engine = new Engine({
		handlers: new Map([
			["command", handler],
			["cleanup", handler],
		]),
	});
	const result = await engine.run(
		new AbortController().signal,
		"fixture-run",
		definition,
	);
	return { seen, result, definition };
}

describe("optional Docker build artifacts", () => {
	for (const labels of [
		null,
		{},
		{ "org.opencontainers.image.title": "ubuntu" },
	]) {
		test(`an image without artifacts succeeds (${JSON.stringify(labels)})`, async () => {
			const { seen, result } = await build(labels);
			expect(result.error).toBeUndefined();
			expect(seen.map((s) => s.args[0])).toEqual(["build", "inspect"]);
		});
	}

	test("a declared path is extracted, then the temporary container is removed", async () => {
		const { seen, result } = await build({
			"devenv.artifacts": "/out/artifacts",
		});
		expect(result.error).toBeUndefined();
		expect(seen.map((s) => s.args[0])).toEqual([
			"build",
			"inspect",
			"create",
			"cp",
			"rm",
		]);
		expect(seen.find((s) => s.args[0] === "cp")?.args).toEqual([
			"cp",
			"fixture-container:/out/artifacts",
			".",
		]);
	});

	for (const path of ["", "  ", " /out", "/out\nfile", 3, null, {}, []]) {
		test(`malformed declared artifact paths fail before creating a container (${JSON.stringify(path)})`, async () => {
			const { seen, result } = await build({ "devenv.artifacts": path });
			expect(result.error?.message).toContain("non-empty artifact path");
			expect(seen.map((s) => s.args[0])).toEqual(["build", "inspect"]);
		});
	}

	test("copy failure still removes the created extractor", async () => {
		const { seen, result } = await build({ "devenv.artifacts": "/out" }, "cp");
		expect(result.error).toBeDefined();
		expect(seen.at(-1)?.args).toEqual(["rm", "fixture-container"]);
	});

	for (const fail of ["build", "inspect", "create"] as const) {
		test(`${fail} failure does not run cleanup with an empty container ID`, async () => {
			const { seen, result } = await build(
				{ "devenv.artifacts": "/out" },
				fail,
			);
			expect(result.error).toBeDefined();
			expect(seen.some((s) => s.args[0] === "rm")).toBe(false);
		});
	}

	test("a build never runs global cache, image or volume pruning", async () => {
		const { seen, definition } = await build({});
		expect(JSON.stringify(definition)).not.toContain("prune");
		expect(seen.some((s) => s.name === "sh")).toBe(false);
	});
});
