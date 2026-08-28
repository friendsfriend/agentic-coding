import { expect, test } from "bun:test";
import { requiredUserActionFor } from "../src/tui/dash/data.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";

test("archive-bearing workflows route through wiki approval", () => {
	const registry = registerBuiltins();
	for (const id of ["standard", "direct-apply", "plan-fusion"]) {
		const definition = registry.definition(id, definitionVersionForPolicy(6));
		const archive = definition.steps.indexOf("core.archive");
		expect(definition.steps[archive + 1]).toBe("core.wiki-approval");
		expect(definition.steps[archive + 2]).toBe("core.delivery");
		expect(
			definition.edges.find(
				(edge) => edge.from === "core.archive" && edge.outcome === "complete",
			)?.to,
		).toBe("core.wiki-approval");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "approve",
			)?.effects?.[0]?.kind,
		).toBe("wiki.verify");
	}
	const noOpenSpec = registry.definition("no-openspec", 1);
	expect(noOpenSpec.steps).not.toContain("core.wiki-approval");
});

test("wiki approval has a trigger-only user action", () => {
	expect(requiredUserActionFor("core.wiki-approval")).toEqual({
		key: "wiki-review",
		title: "Action required · Wiki review",
		prompt: "Review knowledge changes before delivery.",
		items: [],
	});
});
