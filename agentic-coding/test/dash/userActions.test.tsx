/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";

function TestDashboard() {
  const renderer = useRenderer();
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const dispose = keymap.registerLayerFields({
    name() {},
    appView(value, ctx) {
      ctx.require("app.view", String(value));
    },
    activeModal(value, ctx) {
      ctx.require("modal.active", String(value));
    },
  });
  onCleanup(dispose);
  return <App repo="/demo" change="demo" profile="test" keymap={keymap} />;
}

test("dismissed required action stays closed during panel interactions", async () => {
  const t = await testRender(() => <TestDashboard />, {
    width: 120,
    height: 40,
  });

  await t.waitForFrame((frame) =>
    frame.includes("Action required · Approve plan"),
  );
  t.mockInput.pressEscape();
  await t.waitForFrame(
    (frame) => !frame.includes("Action required · Approve plan"),
  );

  t.mockInput.pressTab();
  t.mockInput.pressEnter();
  await t.flush();
  expect(t.captureCharFrame()).not.toContain("Action required · Approve plan");
  t.renderer.destroy();
});

test("required action modal appears and executes plan approval", async () => {
  const t = await testRender(() => <TestDashboard />, {
    width: 120,
    height: 40,
  });

  const actionFrame = await t.waitForFrame((frame) =>
    frame.includes("Action required · Approve plan"),
  );
  expect(actionFrame).toContain("Approve plan and start implementation");
  expect(actionFrame).toContain("Not now");

  t.mockInput.pressEnter();
  const appliedFrame = await t.waitForFrame(
    (frame) =>
      frame.includes("Applying") &&
      !frame.includes("Action required · Approve plan"),
  );
  expect(appliedFrame).toContain("Applying");

  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Verifying"));
  t.mockInput.pressEnter();
  const reviewFrame = await t.waitForFrame((frame) =>
    frame.includes("Changed Files (1 files)"),
  );
  // The developer review user action opens the changed-files popup directly.
  expect(reviewFrame).toContain("Action required · Developer review");
  expect(reviewFrame).not.toContain("Start developer review");
  expect(reviewFrame).toContain("src/example.ts");

  // Enter on the file row opens the diff in the separate diff modal.
  t.mockInput.pressEnter();
  const diffFrame = await t.waitForFrame((frame) =>
    frame.includes("reviewed();"),
  );
  expect(diffFrame).toContain("diff --git a/src/example.ts");
  expect(diffFrame).not.toContain("Changed Files (1 files)");

  // Esc in the diff returns to the files popup.
  t.mockInput.pressEscape();
  await t.waitForFrame((frame) => frame.includes("Changed Files (1 files)"));

  // f finishes the review from the popup: approval is dispatched and the
  // popup closes (message state is shell-level, not rendered in this frame).
  t.mockInput.pressKey("f");
  await t.waitForFrame((frame) => !frame.includes("Changed Files (1 files)"));
  t.renderer.destroy();
});
