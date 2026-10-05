// Side-app launcher (multiplexer removal): the argv builders are pure, so the
// spawned-view launch shape — same executable, route handoff, attach to the
// running server — is pinned without a tmux client or a terminal.
import { describe, expect, test } from "bun:test";
import {
	sideAppMode,
	tmuxWindowName,
	viewWindowArgs,
} from "../src/tui/shared/side-app.ts";

describe("view window argv", () => {
	test("re-execs this application at the route, attached to the server", () => {
		const argv = viewWindowArgs(
			{
				name: "wf-1",
				cwd: "/work/wf-1",
				repository: "/work/repo",
				routeJson: '{"page":"workflows.detail","resourceId":"wf-1"}',
				attachUrl: "http://127.0.0.1:4050",
				token: "capability",
			},
			{ execPath: "/usr/bin/bun", entry: "/app/src/cli.ts" },
		);
		expect(argv).toEqual([
			"/usr/bin/bun",
			"/app/src/cli.ts",
			"home",
			"--repo",
			"/work/repo",
			"--attach-url",
			"http://127.0.0.1:4050",
			"--attach-token",
			"capability",
			"--route",
			'{"page":"workflows.detail","resourceId":"wf-1"}',
		]);
	});

	test("omits the capability when the parent has none", () => {
		const argv = viewWindowArgs(
			{
				name: "home",
				cwd: "/work",
				repository: "/work",
				routeJson: '{"page":"home"}',
				attachUrl: "http://127.0.0.1:4050",
			},
			{ execPath: "/usr/bin/bun" },
		);
		expect(argv).toEqual([
			"/usr/bin/bun",
			"home",
			"--repo",
			"/work",
			"--attach-url",
			"http://127.0.0.1:4050",
			"--route",
			'{"page":"home"}',
		]);
		// A compiled binary runs itself: no entry argument.
		expect(argv).not.toContain("/app/src/cli.ts");
	});
});

describe("tmux window names", () => {
	test("strips the target separator and control characters, and never empties", () => {
		expect(tmuxWindowName("wf-1")).toBe("wf-1");
		expect(tmuxWindowName("a:b")).toBe("a-b");
		expect(tmuxWindowName("\u0000\u001f")).toBe("--");
		expect(tmuxWindowName("")).toBe("workspace");
		expect(tmuxWindowName("x".repeat(100))).toHaveLength(64);
	});
});

describe("side app mode", () => {
	test("tmux only with a client and a binary; local otherwise", () => {
		expect(sideAppMode({ TMUX: "/tmp/tmux-1" }, true)).toBe("tmux");
		expect(sideAppMode({ TMUX: "/tmp/tmux-1" }, false)).toBe("local");
		expect(sideAppMode({}, true)).toBe("local");
	});
});
