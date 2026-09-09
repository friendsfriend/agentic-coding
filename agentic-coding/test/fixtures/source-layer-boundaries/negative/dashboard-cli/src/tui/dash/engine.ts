// Negative fixture: a TUI module imports startup/command logic from the
// workflow CLI layer. The check must fail and identify the application-level
// boundary to use instead.
import { engine as cliEngine, drainEffects } from "../../workflow/cli.ts";

export function runFromDashboard(): void {
	cliEngine();
	void drainEffects;
}