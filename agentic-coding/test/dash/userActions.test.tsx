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
  const reviewActionFrame = await t.waitForFrame((frame) =>
    frame.includes("Action required · Developer review"),
  );
  expect(reviewActionFrame).toContain("Start developer review");

  t.mockInput.pressEnter();
  const reviewFrame = await t.waitForFrame((frame) =>
    frame.includes("Changed Files (1 files)"),
  );
  expect(reviewFrame).not.toContain("Action required · Developer review");
  t.renderer.destroy();
});
