// The `expect` handed to `browser_run_script` (`add-agent-browser-sessions`).
//
// The script tool runs the agent's JavaScript with `page`, `context` and
// `expect`. `@playwright/test` is not a dependency of the server (the saved
// repro spec is what the developer runs with the real thing), so the in-server
// `expect` is a small, explicit subset: the matchers a browser script actually
// asserts with, each throwing when it fails so the tool reports the failure
// instead of silently passing.

export interface ScriptExpectation {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toContain(expected: unknown): void;
	toBeTruthy(): void;
	toBeFalsy(): void;
	toBeGreaterThan(expected: number): void;
	toBeLessThan(expected: number): void;
	not: ScriptExpectation;
}

export type ScriptExpect = (actual: unknown) => ScriptExpectation;

function fail(message: string): never {
	throw new Error(message);
}

function stringify(value: unknown): string {
	try {
		return typeof value === "string" ? JSON.stringify(value) : String(value);
	} catch {
		return "<unserializable>";
	}
}

function equals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (typeof left !== "object" || typeof right !== "object") return false;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

/** Whether one value contains another: a string in a string, or a member of an
 * array. Anything else is a failure rather than a silent pass. */
function contains(left: unknown, right: unknown): boolean {
	if (typeof left === "string" && typeof right === "string")
		return left.includes(right);
	if (Array.isArray(left)) return left.some((item) => equals(item, right));
	return false;
}

function expectation(actual: unknown, negated: boolean): ScriptExpectation {
	const check = (holds: boolean, describe: string): void => {
		// A positive expectation fails when it does not hold; a negated one fails
		// when it does. Either way the failure is the tool's outcome.
		if (holds === !negated) return;
		fail(
			negated
				? `expected ${stringify(actual)} not ${describe}`
				: `expected ${stringify(actual)} ${describe}`,
		);
	};
	const self: ScriptExpectation = {
		toBe: (expected) =>
			check(actual === expected, `to be ${stringify(expected)}`),
		toEqual: (expected) =>
			check(equals(actual, expected), `to equal ${stringify(expected)}`),
		toContain: (expected) =>
			check(contains(actual, expected), `to contain ${stringify(expected)}`),
		toBeTruthy: () => check(Boolean(actual), "to be truthy"),
		toBeFalsy: () => check(!actual, "to be falsy"),
		toBeGreaterThan: (expected) =>
			check(
				typeof actual === "number" && actual > expected,
				`to be greater than ${expected}`,
			),
		toBeLessThan: (expected) =>
			check(
				typeof actual === "number" && actual < expected,
				`to be less than ${expected}`,
			),
		get not() {
			return expectation(actual, !negated);
		},
	};
	return self;
}

/** The `expect` a `browser_run_script` body receives. */
export function createScriptExpect(): ScriptExpect {
	return (actual: unknown) => expectation(actual, false);
}
