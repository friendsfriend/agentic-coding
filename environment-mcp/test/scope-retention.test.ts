import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openOperationJournal } from "../src/services/operation-journal.ts";

function fixture() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-retention-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	return { root, repository, state };
}

test("scope capacity refuses to evict active scopes", () => {
	const { root, repository, state } = fixture();
	const journal = openOperationJournal(state, [repository]);
	try {
		for (let index = 0; index < 64; index++)
			journal.createScope("principal", repository, `scope-${index}`);
		expect(() =>
			journal.createScope("principal", repository, "scope-64"),
		).toThrow("journal-capacity");
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("scope capacity evicts only the oldest inactive scope", () => {
	const { root, repository, state } = fixture();
	const journal = openOperationJournal(state, [repository]);
	try {
		const scopes = [];
		for (let index = 0; index < 64; index++) {
			const scope = journal.createScope(
				"principal",
				repository,
				`scope-${index}`,
			);
			scopes.push(scope);
			const bound = journal.bind("principal", scope.id);
			const closing = bound.beginClose(scope.revision);
			bound.finishClose(closing.scope.revision, true);
		}
		const oldest = scopes[0];
		if (!oldest) throw new Error("Missing fixture scope");
		const replacement = journal.createScope(
			"principal",
			repository,
			"scope-64",
		);
		expect(replacement.id).not.toBe(oldest.id);
		expect(() => journal.bind("principal", oldest.id).scope()).toThrow(
			"scope-unavailable",
		);
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
