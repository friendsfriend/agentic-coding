import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { beginShutdown, beginStartup, finishStartup, setStepActive, setStepDone } from "../src/tui/lifecycle";
import { LifecycleModal } from "../src/tui/lifecycle/LifecycleModal";

// Renderer-level lifecycle modal test (pattern: test/dash/modalCentering.test.ts).
// The modal is a Portal overlay anchored at the renderer root; it must be
// visible only while phase is starting/stopping.
test("lifecycle modal renders at the renderer root only while starting/stopping", async () => {
  const t = await testRender(() => <LifecycleModal />, { width: 80, height: 24 });
  await t.flush();

  // Idle: no modal.
  let frame = t.captureCharFrame();
  expect(frame).not.toContain("Starting server");

  // Startup: modal with title and steps.
  beginStartup([
    { id: "history", label: "Loading workspace history" },
    { id: "receiver", label: "Starting telemetry receiver" },
  ]);
  await t.flush();
  frame = t.captureCharFrame();
  expect(frame).toContain("Starting server");
  expect(frame).toContain("Loading workspace history");
  expect(frame).toContain("Starting telemetry receiver");

  // Step completion is reflected in the modal.
  setStepActive("history");
  setStepDone("history");
  await t.flush();
  frame = t.captureCharFrame();
  expect(frame).toContain("Loading workspace history");

  // Running: modal gone.
  finishStartup();
  await t.flush();
  frame = t.captureCharFrame();
  expect(frame).not.toContain("Starting server");
  expect(frame).not.toContain("Loading workspace history");

  // Shutdown: modal with stop steps.
  beginShutdown([{ id: "receiver", label: "Stopping telemetry receiver" }]);
  await t.flush();
  frame = t.captureCharFrame();
  expect(frame).toContain("Stopping server");
  expect(frame).toContain("Stopping telemetry receiver");

  t.renderer.destroy();
});
