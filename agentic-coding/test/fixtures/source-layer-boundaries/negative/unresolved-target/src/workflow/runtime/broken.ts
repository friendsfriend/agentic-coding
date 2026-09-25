// Negative fixture: a project-relative runtime target that cannot be
// resolved must fail with an actionable source/specifier diagnostic.
import { missingHelper } from "./missing.ts";

export function brokenRead(): unknown {
	return missingHelper();
}

// Optional-chained require is still a literal module edge the guard must record.
export function brokenOptionalRead(): unknown {
	return require?.("./missing-optional.ts");
}