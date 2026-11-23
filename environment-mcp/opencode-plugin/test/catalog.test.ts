import { describe, expect, test } from "bun:test";
import type { UiActionDescriptor } from "../../src/ui/capability-api.ts";
import {
	actionBadges,
	fieldChoices,
	filterActions,
	groupActions,
	groupFor,
	previewFields,
} from "../src/catalog.ts";

const list: UiActionDescriptor = {
	name: "env_list",
	label: "List environments",
	description: "Inspect configured applications and targets.",
	annotations: { readOnlyHint: true, idempotentHint: true },
	inputSchema: {
		type: "object",
		properties: {
			repository: { type: "string", description: "Authorized repository" },
			limit: { type: "integer", default: 10 },
		},
		required: ["repository"],
	},
};

const execute: UiActionDescriptor = {
	name: "env_execute",
	label: "Prepare execution",
	description: "Request exact human approval for a build or run target.",
	annotations: {
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: { type: "object", properties: {} },
};

const telemetry: UiActionDescriptor = {
	name: "env_telemetry",
	label: "Run telemetry",
	description: "Read bounded logs and trace summaries for one owned app.",
	annotations: { readOnlyHint: true },
	inputSchema: {
		type: "object",
		properties: {
			app: { type: "string" },
			traceId: { type: "string" },
		},
		required: ["app"],
	},
};

describe("capability catalog", () => {
	test("groups known capabilities in inspect, operate, observe order", () => {
		expect(groupFor(list)).toBe("Inspect");
		expect(groupFor(execute)).toBe("Operate");
		expect(groupFor(telemetry)).toBe("Observe");
		expect(
			groupActions([telemetry, execute, list]).map((group) => group.group),
		).toEqual(["Inspect", "Operate", "Observe"]);
	});

	test("filters by every whitespace-separated term", () => {
		expect(filterActions([list, execute, telemetry], "telemetry")).toEqual([
			telemetry,
		]);
		expect(filterActions([list, execute, telemetry], "OWNED logs")).toEqual([
			telemetry,
		]);
		expect(filterActions([list, execute, telemetry], "missing")).toEqual([]);
		expect(filterActions([list, execute, telemetry], "  ")).toHaveLength(3);
	});

	test("derives annotation badges and field previews", () => {
		expect(actionBadges(execute).map((badge) => badge.label)).toEqual([
			"destructive",
			"idempotent",
			"open-world",
		]);
		const preview = previewFields(list);
		if (!("fields" in preview)) throw new Error("expected fields");
		expect(preview.fields.map((field) => field.name)).toEqual([
			"repository",
			"limit",
		]);
		const first = preview.fields[0];
		if (!first) throw new Error("expected repository field");
		expect(first.required).toBe(true);
		expect(previewFields({ ...list, inputSchema: { type: "array" } })).toEqual({
			error: "Capability input must be an object",
		});
		expect(fieldChoices({ ...first, kind: "boolean" })).toEqual([
			"false",
			"true",
		]);
		expect(
			fieldChoices({
				...first,
				enumValues: ["docker", "podman"],
			}),
		).toEqual(["docker", "podman"]);
	});
});
