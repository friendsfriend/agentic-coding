import type { StepBehavior } from "./types.ts";

export const lifecycleBehaviors: Readonly<Record<string, StepBehavior>> = {
	"core.plan-approval": {},
	"core.developer-review": {},
	"core.wiki-approval": {},
	"core.delivery": {},
	"core.completed": {},
	"core.closed": {},
	"core.archive": {
		roles: () => ["archive"],
		candidateRoles: () => ["archive"],
	},
};
