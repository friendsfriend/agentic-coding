import { expect, test } from "bun:test";
import {
	type OperationRecord,
	operationSubject,
	operationView,
} from "../src/domain/operation.ts";

const record: OperationRecord = {
	id: "00000000-0000-4000-8000-000000000001",
	scope: "00000000-0000-4000-8000-000000000002",
	host: "00000000-0000-4000-8000-000000000003",
	kind: "executable",
	identity: "{}",
	plan: JSON.stringify({
		intent: { app: "api", target: "dev" },
		descriptor: { action: "run" },
		workspace: { directory: "/repo/api" },
	}),
	digest: "a".repeat(64),
	state: "issued",
	revision: 1,
	createdAt: 1,
	inspectionRequired: false,
};

test("operation view exposes only safe subject attribution", () => {
	expect(operationSubject(record)).toEqual({
		app: "api",
		target: "dev",
		action: "run",
		repository: "/repo/api",
	});
	const view = operationView(record, record.host);
	expect(view.subject).toEqual({
		app: "api",
		target: "dev",
		action: "run",
		repository: "/repo/api",
	});
	expect("plan" in view).toBe(false);
	expect("identity" in view).toBe(false);
});

test("malformed plans do not leak or break the projection", () => {
	const malformed = { ...record, plan: "{" };
	expect(operationSubject(malformed)).toBeUndefined();
	expect(operationView(malformed, record.host).subject).toBeUndefined();
});
