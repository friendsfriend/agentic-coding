import { expect, test } from "bun:test";
import type {
	OperatorApi,
	OperatorOperation,
	OperatorOperationSummary,
} from "../src/operator/client.ts";
import { createOperatorUiController } from "../src/operator/controller.ts";

function operation(
	overrides: Partial<OperatorOperation> = {},
): OperatorOperation {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		scope: "22222222-2222-4222-8222-222222222222",
		host: "33333333-3333-4333-8333-333333333333",
		kind: "dependency-bindings",
		identity: "fixture",
		plan: '{"fixture":true}',
		digest: "a".repeat(64),
		state: "awaiting-approval",
		revision: 3,
		createdAt: 1_700_000_000,
		inspectionRequired: false,
		...overrides,
	};
}
const summary = (value: OperatorOperation): OperatorOperationSummary => ({
	id: value.id,
	scope: value.scope,
	state: value.state,
	revision: value.revision,
	digest: value.digest,
	inspectionRequired: value.inspectionRequired,
	createdAt: value.createdAt,
});

test("operator UI reviews the exact operation and submits a fenced decision", async () => {
	const pending = operation();
	const decisions: {
		id: string;
		input: { requestId: string; digest: string; revision: number };
	}[] = [];
	const api: OperatorApi = {
		async list() {
			return {
				operations: [summary(pending)],
				total: 1,
				nextOffset: null,
			};
		},
		async inspect(id) {
			expect(id).toBe(pending.id);
			return pending;
		},
		async decide(id, input) {
			decisions.push({ id, input });
			return { ...pending, state: "approved", revision: pending.revision + 1 };
		},
		async acknowledge() {
			throw new Error("unexpected acknowledgement");
		},
	};
	const controller = createOperatorUiController(api);
	await controller.load();
	expect(controller.getSnapshot()).toMatchObject({
		view: "list",
		selectedIndex: 0,
	});
	await controller.inspectSelected();
	expect(controller.getSnapshot().view).toBe("detail");
	controller.requestDecision("approved");
	expect(controller.getSnapshot().view).toBe("confirm");
	await controller.confirmDecision();
	expect(decisions).toHaveLength(1);
	expect(decisions[0]?.id).toBe(pending.id);
	expect(decisions[0]?.input).toMatchObject({
		digest: pending.digest,
		revision: pending.revision,
	});
	expect(decisions[0]?.input.requestId.length).toBeGreaterThan(0);
	expect(controller.getSnapshot()).toMatchObject({
		view: "result",
		decision: "approved",
		operation: { state: "approved", revision: pending.revision + 1 },
	});
});

test("operator UI acknowledges only an exact inspection-required interruption", async () => {
	const uncertain = operation({
		state: "interrupted",
		inspectionRequired: true,
	});
	let acknowledgements = 0;
	const api: OperatorApi = {
		async list() {
			return {
				operations: [summary(uncertain)],
				total: 1,
				nextOffset: null,
			};
		},
		async inspect() {
			return uncertain;
		},
		async decide() {
			throw new Error("unexpected decision");
		},
		async acknowledge(id, input) {
			acknowledgements++;
			expect(id).toBe(uncertain.id);
			expect(input).toMatchObject({
				digest: uncertain.digest,
				revision: uncertain.revision,
			});
			return {
				...uncertain,
				inspectionRequired: false,
				revision: uncertain.revision + 1,
			};
		},
	};
	const controller = createOperatorUiController(api);
	await controller.load();
	await controller.inspectSelected();
	await controller.acknowledge();
	expect(acknowledgements).toBe(1);
	expect(controller.getSnapshot()).toMatchObject({
		view: "result",
		decision: "acknowledged",
		operation: { inspectionRequired: false },
	});
});
