// Workflow worktree layout: the runner must pass an explicit root so a custom
// path (Home's New workflow entry) never falls back to worktrunk's two-level
// default next to the user's directory.
import { describe, expect, test } from "bun:test";
import {
	workflowWorktreeLocation,
	workflowWorktreeRoot,
} from "../src/worktree/layout.ts";

const HOME = "/home/u/devenv";

describe("workflow worktree layout", () => {
	test("a managed project keeps its bare ident under the workflow root", () => {
		expect(workflowWorktreeLocation(`${HOME}/api/api`, HOME)).toEqual({
			root: `${HOME}/worktrees`,
			ident: "api",
		});
	});

	test("a custom path gets a collision-safe ident", () => {
		const location = workflowWorktreeLocation("/srv/app", HOME);
		expect(location.root).toBe(`${HOME}/worktrees`);
		expect(location.ident).toMatch(/^app-[0-9a-f]{8}$/);
		// Two repositories that share a directory name never share a container.
		expect(workflowWorktreeLocation("/srv/one/app", HOME).ident).not.toBe(
			workflowWorktreeLocation("/srv/two/app", HOME).ident,
		);
	});

	test("the root is a separate subdirectory, not the home itself", () => {
		expect(workflowWorktreeRoot(HOME)).toBe(`${HOME}/worktrees`);
		expect(workflowWorktreeRoot(HOME)).not.toBe(HOME);
	});
});
