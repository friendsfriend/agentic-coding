import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openOperationJournal } from "../src/services/operation-journal.ts";

const digestPlan = (
	scope: { id: string; principal: string; workspace: unknown },
	label: string,
) =>
	JSON.stringify({
		kind: "dependency-bindings",
		scope: scope.id,
		principal: scope.principal,
		workspace: scope.workspace,
		label,
	});

test("cleanup fences only report resources created under an issued operation and retain uncertainty", () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-owned-")),
	);
	const repository = path.join(root, "repo"),
		state = path.join(root, "state");
	fs.mkdirSync(repository);
	fs.mkdirSync(state, { mode: 0o700 });
	const journal = openOperationJournal(state, [repository]);
	try {
		const operator = journal.operator();
		const scope = journal.createScope("client", repository, "scope");
		const session = journal.bind("client", scope.id);
		const operation = session.admit(
			"review",
			JSON.stringify({ label: "owned" }),
			digestPlan(scope, "owned"),
		);
		operator.decide(operation.id, {
			requestId: "approve",
			digest: operation.digest,
			revision: operation.revision,
			decision: "approved",
		});
		const issued = session.issue(operation.id, {
			digest: operation.digest,
			revision: operation.revision + 1,
		});
		if (!issued.permit) throw new Error("Missing fixture permit");
		expect(session.owned()).toEqual([]);
		const [claimed] = session.claimOwned(issued.permit, "api", [
			{ kind: "container", runtimeId: "a".repeat(64) },
		]);
		if (!claimed) throw new Error("Missing fixture owned resource");
		// A copied permit has no completion/claim authority.
		expect(() =>
			session.claimOwned({ ...issued.permit }, "api", [
				{ kind: "container", runtimeId: "b".repeat(64) },
			]),
		).toThrow("operation-unavailable");
		expect(session.owned()).toMatchObject([
			{
				id: claimed.id,
				app: "api",
				kind: "container",
				runtimeId: "a".repeat(64),
			},
		]);
		const foreign = journal.bind("other-client", scope.id);
		expect(() => foreign.owned()).toThrow("scope-unavailable");
		// Closing fences the scope but reports only the created resource.
		const began = session.beginClose(scope.revision);
		expect(began.scope.state).toBe("closing");
		expect(began.owned).toHaveLength(1);
		expect(began.owned).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ runtimeId: "postgres" }),
			]),
		);
		// Failed/uncertain cleanup keeps the record for inspection.
		expect(session.finishClose(began.scope.revision, false).state).toBe(
			"interrupted",
		);
		expect(session.owned()).toHaveLength(1);
		// A confirmed cleanup path clears only its own owned records.
		const second = journal.createScope("client", repository, "second");
		const another = journal.bind("client", second.id);
		const secondOperation = another.admit(
			"review",
			JSON.stringify({ label: "second" }),
			digestPlan(
				{
					id: second.id,
					principal: second.principal,
					workspace: second.workspace,
				},
				"second",
			),
		);
		operator.decide(secondOperation.id, {
			requestId: "approve-second",
			digest: secondOperation.digest,
			revision: secondOperation.revision,
			decision: "approved",
		});
		const secondIssued = another.issue(secondOperation.id, {
			digest: secondOperation.digest,
			revision: secondOperation.revision + 1,
		});
		if (!secondIssued.permit) throw new Error("Missing second permit");
		another.claimOwned(secondIssued.permit, "web", [
			{ kind: "container", runtimeId: "c".repeat(64) },
		]);
		const secondBegin = another.beginClose(second.revision);
		expect(another.finishClose(secondBegin.scope.revision, true).state).toBe(
			"closed",
		);
		expect(another.owned()).toEqual([]);
		// The interrupted scope's owned record is untouched by the other close.
		expect(session.owned()).toHaveLength(1);
		expect(() =>
			another.admit(
				"after-close",
				JSON.stringify({ label: "after-close" }),
				digestPlan(
					{
						id: second.id,
						principal: second.principal,
						workspace: second.workspace,
					},
					"after-close",
				),
			),
		).toThrow("scope-unavailable");
	} finally {
		journal.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
