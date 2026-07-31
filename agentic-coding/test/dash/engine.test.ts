import { expect, test } from "bun:test";
import { runWorkflowAction } from "../../src/tui/dash/engine";

test("runWorkflowAction rejects unknown actions before touching the engine", async () => {
  await expect(runWorkflowAction("bogus", ".", "change")).rejects.toThrow(/unknown workflow action: bogus/);
});
