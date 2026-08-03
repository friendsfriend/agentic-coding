import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core";

// Regression test for dashboard-modal-centering: dash modals draw an absolute
// overlay sized to the terminal, so the overlay must anchor at the renderer
// root (what <Portal> does), not at the tab-content box the dashboard renders
// in (offset by header + tab bar + status bar).
const W = 80;
const H = 24;
const DIALOG_H = 8;

function titleRow(frame: string): number {
  return frame.split("\n").findIndex(line => line.includes("TITLE"));
}

/** GenericModal-style overlay: absolute box at terminal origin, centered dialog. */
function makeOverlay(renderer: Renderable, dialogHeight: number): BoxRenderable {
  const overlay = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0,
    left: 0,
    width: W,
    height: H,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
  });
  const dialog = new BoxRenderable(renderer, {
    width: 40,
    height: dialogHeight,
    flexDirection: "column",
    alignItems: "center",
  });
  dialog.add(new TextRenderable(renderer, { content: "TITLE" }));
  overlay.add(dialog);
  return overlay;
}

test("modal overlay anchored at the renderer root centers on the terminal, not the tab-content box", async () => {
  const t = await createTestRenderer({ width: W, height: H });
  const { renderer } = t;

  // Real-app shell: header + tab bar + status bar shrink the content box.
  const app = new BoxRenderable(renderer, { width: W, height: H, flexDirection: "column" });
  const header = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const tabBar = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  const content = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1 });
  const statusBar = new BoxRenderable(renderer, { height: 1, flexShrink: 0 });
  app.add(header);
  app.add(tabBar);
  app.add(content);
  app.add(statusBar);
  renderer.root.add(app);

  // Post-fix: overlay mounted at the renderer root (Portal's mount point).
  const rootOverlay = makeOverlay(renderer, DIALOG_H);
  renderer.root.add(rootOverlay);
  await t.flush();
  const rootFrame = t.captureCharFrame();
  expect(titleRow(rootFrame)).toBe((H - DIALOG_H) / 2);

  // Pre-fix: same overlay anchored inside the tab-content box is pushed down
  // by the chrome — would fail the center assertion above.
  renderer.root.remove(rootOverlay.id);
  content.add(makeOverlay(renderer, DIALOG_H));
  await t.flush();
  const nestedFrame = t.captureCharFrame();
  expect(titleRow(nestedFrame)).not.toBe((H - DIALOG_H) / 2);
  expect(titleRow(nestedFrame)).toBeGreaterThan((H - DIALOG_H) / 2);
});
