/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ErrorDialog } from "../../src/tui/dash/ui/ErrorDialog";
import { GenericModal } from "../../src/tui/dash/ui/GenericModal";

test("error dialog renders above an existing modal", async () => {
  const t = await testRender(() => <>
    <ErrorDialog title="Workflow failed" message="Visible error" onClose={() => {}} />
    <GenericModal title="New workflow" widthPercent={0.7} heightPercent={0.55} help={[]}>
      <text>Hidden workflow form</text>
    </GenericModal>
  </>, { width: 80, height: 24 });

  await t.flush();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Workflow failed");
  expect(frame).toContain("Visible error");
  expect(frame).not.toContain("New workflow");
  t.renderer.destroy();
});
