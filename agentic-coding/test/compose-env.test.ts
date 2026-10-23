import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionStepDefinition } from "@devenv/types";
import { compileDockerLifecycleActions } from "../src/server/actions/compile.ts";
import { composeFileArgs } from "../src/server/actions/compose-env.ts";
import { compileContainerTargets } from "../src/server/actions/target-compile.ts";
import type { ActionTarget } from "../src/server/actions/targets.ts";

function steps(root: ActionStepDefinition): ActionStepDefinition[] {
	return [root, ...(root.children ?? []).flatMap(steps)];
}

function fixture(run: (configDir: string, envFile: string) => void) {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-env-"));
	try {
		const envFile = path.join(configDir, ".env");
		fs.writeFileSync(
			envFile,
			"ICON_APPLICATION_MASTERPASSWORD=fixture-secret\n",
		);
		run(configDir, envFile);
	} finally {
		fs.rmSync(configDir, { recursive: true, force: true });
	}
}

const target: ActionTarget = {
	id: "document-service",
	action: "run",
	runtime: "docker",
	label: "Mocked",
	sourcePath: "/config/apps/compose/document-service-Mocked-compose.yml",
};

describe("central Compose interpolation environment", () => {
	test("applications and readiness use the central file for Docker and Podman", () => {
		fixture((configDir, envFile) => {
			const definitions = compileContainerTargets(
				"document-service",
				target,
				undefined,
				{
					configDir,
					checkoutDir: "/unrelated/checkout",
					sourceExists: () => true,
				},
			);
			expect(definitions.map((d) => d.runtime)).toEqual(["docker", "podman"]);
			for (const definition of definitions) {
				const compose = steps(definition.root).filter(
					(s) => s.configuration?.command,
				);
				expect(compose).toHaveLength(2);
				for (const step of compose) {
					expect(
						((step.configuration?.args ?? []) as string[]).slice(0, 4),
					).toEqual(["--env-file", envFile, "-f", target.sourcePath]);
				}
				expect(JSON.stringify(definition)).not.toContain("fixture-secret");
			}
		});
	});

	test("recursive Compose dependencies inherit config for shell and tmux parents", () => {
		fixture((configDir, envFile) => {
			const parent: ActionTarget = {
				...target,
				runtime: "shell",
				command: "true",
				requires: [{ app: "middle" }],
			};
			const definitions = compileContainerTargets(
				"parent",
				parent,
				(ref) => ({
					appIdent: ref.app ?? "dependency",
					target: {
						...target,
						requires:
							ref.app === "middle" ? [{ app: "leaf", provider: "podman" }] : [],
					},
				}),
				{ configDir },
			);
			expect(definitions.map((d) => d.runtime)).toEqual([
				"tmux",
				"command-shell",
			]);
			for (const definition of definitions) {
				const compose = steps(definition.root).filter((s) =>
					String(s.configuration?.command ?? "").includes("compose"),
				);
				expect(compose).toHaveLength(2);
				for (const step of compose)
					expect(
						((step.configuration?.args ?? []) as string[]).slice(0, 2),
					).toEqual(["--env-file", envFile]);
			}
		});
	});

	test("stop and restart use the same environment for both providers", () => {
		fixture((configDir, envFile) => {
			const definitions = compileDockerLifecycleActions(
				"document-service",
				target,
				configDir,
			);
			expect(definitions).toHaveLength(4);
			for (const definition of definitions) {
				for (const step of steps(definition.root).filter(
					(s) => s.kind === "command",
				)) {
					expect(
						((step.configuration?.args ?? []) as string[]).slice(0, 4),
					).toEqual(["--env-file", envFile, "-f", target.sourcePath]);
				}
			}
		});
	});

	test("missing or unspecified central env preserves existing Compose discovery", () => {
		fixture((configDir, envFile) => {
			fs.unlinkSync(envFile);
			expect(composeFileArgs(target.sourcePath, configDir)).toEqual([
				"-f",
				target.sourcePath,
			]);
			expect(composeFileArgs(target.sourcePath, "")).toEqual([
				"-f",
				target.sourcePath,
			]);
		});
	});
});
