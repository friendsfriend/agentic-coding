// A caller that still imports the removed migration bridge. The obsolete-shim
// check must flag this resolved import.
import { drain } from "./legacy-bridge.ts";

export function run(): number {
	return drain();
}
