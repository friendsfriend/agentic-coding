import { expect, test } from "bun:test";
import { Effect, Schema, SchemaGetter } from "effect";
import { ContractFailure, decodeContract } from "../src/contracts/decode.ts";
import { decodeStageDefinition } from "../src/server/stages/schema.ts";

const record = Schema.Struct({
	name: Schema.String,
	tags: Schema.Array(Schema.String).pipe(
		Schema.withDecodingDefaultKey(Effect.sync(() => [])),
	),
});
const document = Schema.Struct({
	records: Schema.Array(record),
	metadata: record,
});

test("snapshot preservation retains nested unknowns without undoing defaults", () => {
	const input = {
		records: [{ name: "entry", future: { enabled: true } }],
		metadata: { name: "metadata", future: [1, 2] },
		future: { version: 2 },
	};
	expect(
		decodeContract("compat", document, input, {
			onExcessProperty: "preserve",
		}),
	).toEqual({
		records: [{ name: "entry", tags: [], future: { enabled: true } }],
		metadata: { name: "metadata", tags: [], future: [1, 2] },
		future: { version: 2 },
	});
	expect(decodeContract("compat", document, input)).toEqual({
		records: [{ name: "entry", tags: [] }],
		metadata: { name: "metadata", tags: [] },
	});
	expect(() =>
		decodeContract(
			"compat",
			document,
			{ ...input, metadata: { name: 7 } },
			{
				onExcessProperty: "preserve",
			},
		),
	).toThrow(ContractFailure);
});

test("preservation keeps normalized values and does not set object prototypes", () => {
	const input: unknown = JSON.parse(
		'{"name":"entry","__proto__":{"polluted":true}}',
	);
	const schema = Schema.Struct({
		name: Schema.String.pipe(
			Schema.decodeTo(Schema.String, {
				decode: SchemaGetter.transform((value) => value.toUpperCase()),
				encode: SchemaGetter.transform((value) => value),
			}),
		),
	});
	const decoded = decodeContract<Record<string, unknown>>(
		"compat",
		schema,
		input,
		{
			onExcessProperty: "preserve",
		},
	);
	expect(decoded.name).toBe("ENTRY");
	expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
	expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
	expect(decoded.polluted).toBeUndefined();
});

test("exact optional fields reject undefined and defaults are fresh per decode", () => {
	const schema = Schema.Struct({
		value: Schema.optionalKey(Schema.String),
		tags: record.fields.tags,
	});
	const first = Schema.decodeUnknownSync(schema)({});
	const second = Schema.decodeUnknownSync(schema)({});
	expect(first.tags).toEqual([]);
	expect(first.tags).not.toBe(second.tags);
	expect(() =>
		Schema.decodeUnknownSync(schema)({ value: undefined }),
	).toThrow();
});

test("v4 contract and stage diagnostics never report rejected input values", () => {
	const secret = "credential-secret-do-not-report";
	try {
		decodeContract("compat", Schema.Struct({ count: Schema.Number }), {
			count: secret,
		});
		throw new Error("expected contract rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(ContractFailure);
		if (!(error instanceof ContractFailure)) throw error;
		expect(error.issues[0]?.path).toBe("$.count");
		expect(error.message).not.toContain(secret);
	}
	const stage = decodeStageDefinition({ name: secret });
	expect(stage.ok).toBe(false);
	expect(JSON.stringify(stage)).not.toContain(secret);
});
