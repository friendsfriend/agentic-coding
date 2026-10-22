// The stage-scope rules an authored data block has to satisfy, in one place.
//
// The save route and the promotion effect both apply them: saving a draft is the
// authoring boundary, promotion is the publishing boundary, and a document must
// not become publishable by any path the authoring boundary would not allow
// (`SEC-002`). Pure: the caller supplies the stage entry it read.

import type { StageDataBlockDocument } from "./data-block.ts";

export interface StageBlockScopeIssue {
	readonly code:
		| "stage-app-unknown"
		| "block-role-undeclared"
		| "block-destructive-refused"
		| "stage-read-only";
	readonly message: string;
}

export interface StageBlockScopeInput {
	readonly stage: string;
	readonly access: "read-only" | "writable";
	/** The applications the pinned stage declares, by key. */
	readonly apps: Readonly<
		Record<string, { readonly roles?: Readonly<Record<string, unknown>> }>
	>;
}

/** Every reason this document may not be used against this stage. An empty list
 * means the document is in scope. */
export function stageBlockScopeIssues(
	document: StageDataBlockDocument,
	input: StageBlockScopeInput,
): StageBlockScopeIssue[] {
	const issues: StageBlockScopeIssue[] = [];
	const app = input.apps[document.app];
	if (app === undefined) {
		issues.push({
			code: "stage-app-unknown",
			message: `stage ${input.stage} does not declare application ${document.app}`,
		});
	} else
		for (const role of document.roles ?? [])
			if (app.roles?.[role] === undefined)
				issues.push({
					code: "block-role-undeclared",
					message: `application ${document.app} of stage ${input.stage} declares no role ${JSON.stringify(role)}`,
				});
	if (document.effects.includes("destructive"))
		issues.push({
			code: "block-destructive-refused",
			message:
				"a data block declares no destructive effect; author it as a checked-in block instead",
		});
	if (document.effects.includes("write") && input.access !== "writable")
		issues.push({
			code: "stage-read-only",
			message: `stage ${input.stage} is read-only, so a data block with effect write cannot be authored against it`,
		});
	return issues;
}
