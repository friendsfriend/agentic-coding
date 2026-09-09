// Negative fixture: a project-relative runtime target that cannot be
// resolved must fail with an actionable source/specifier diagnostic.
import { missingHelper } from "./missing.ts";

export function brokenRead(): unknown {
	return missingHelper();
}