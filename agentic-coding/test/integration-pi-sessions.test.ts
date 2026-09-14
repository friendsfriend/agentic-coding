// Pi session discovery parity (`port-git-providers-and-ai-to-bun`, task 4.1).
// Replays the Go-created fixtures: the same session directory tree, the same
// grouped result.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	hasExecutable,
	parsePiSessionFile,
	piSessionsBase,
	queryPiSessions,
} from "../src/server/integrations/pi-sessions.ts";

const FIXTURES = path.join(
	import.meta.dir,
	"fixtures",
	"integrations",
	"pi-sessions",
);

interface SessionFixture {
	case: string;
	note: string;
	files: { path: string; content: string }[];
	agents: {
		name: string;
		model: string;
		sessions: {
			id: string;
			title: string;
			timeCreated: number;
			timeUpdated: number;
		}[];
	}[];
}

function materialize(root: string, fixture: SessionFixture): void {
	for (const file of fixture.files) {
		const target = path.join(root, ...file.path.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.content);
	}
}

describe("pi session discovery parity (cross-runtime fixtures)", () => {
	for (const name of fs.readdirSync(FIXTURES).sort()) {
		const fixturePath = path.join(FIXTURES, name, "fixture.json");
		if (!fs.existsSync(fixturePath)) continue;
		test(`reproduces the Go listing: ${name}`, () => {
			const fixture = JSON.parse(
				fs.readFileSync(fixturePath, "utf8"),
			) as SessionFixture;
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
			materialize(root, fixture);
			const env = { ...process.env, PI_CODING_AGENT_DIR: root };
			const groups = queryPiSessions({ env, hasPi: true });
			// Session ids are absolute; compare them relative to the fixture root.
			const relative = groups.map((group) => ({
				name: group.name,
				model: group.model,
				sessions: group.sessions.map((session) => ({
					...session,
					id: path.relative(root, session.id).split(path.sep).join("/"),
				})),
			}));
			expect(relative).toEqual(fixture.agents);
			fs.rmSync(root, { recursive: true, force: true });
		});
	}
});

describe("pi session discovery bounds", () => {
	test("an absent sessions directory and a missing pi are both empty", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missing-"));
		const env = { ...process.env, PI_CODING_AGENT_DIR: root };
		expect(queryPiSessions({ env, hasPi: true })).toEqual([]);
		expect(queryPiSessions({ env, hasPi: false })).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("the sessions base honours PI_CODING_AGENT_DIR", () => {
		expect(piSessionsBase({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe(
			path.join("/tmp/agent", "sessions"),
		);
		expect(piSessionsBase({})).toBe(
			path.join(os.homedir(), ".pi", "agent", "sessions"),
		);
	});

	test("an executable lookup is a PATH scan, not a shell", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bin-"));
		fs.writeFileSync(path.join(dir, "pi"), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
		expect(hasExecutable("pi", { PATH: dir })).toBe(true);
		expect(hasExecutable("pi", { PATH: "/nonexistent" })).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a session file is never executed and its content is not interpreted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-content-"));
		const file = path.join(dir, "x.jsonl");
		// A shell command in the content must stay inert text.
		fs.writeFileSync(
			file,
			'{"type":"session","timestamp":"2026-01-02T03:04:05Z","cwd":"/tmp/$(touch pwned)"}\n' +
				'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"rm -rf /"}]}}\n',
		);
		const parsed = parsePiSessionFile(file);
		expect(parsed?.cwd).toBe("/tmp/$(touch pwned)");
		expect(parsed?.session.title).toBe("rm -rf /");
		expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
