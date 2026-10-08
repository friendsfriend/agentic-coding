# Design

## Context

Dashboard panels live in `src/tui/dash/panels/` and are composed by
`panel-grid.ts`; keybinds are declared in `src/tui/dash/keybinds.ts` with a panel
`context`. OpenTUI 0.5.14 exposes kitty image transport on the renderer and an
`Image` renderable.

## Goals / Non-Goals

**Goals:** fast access to evidence; inline images where supported; graceful
fallback.

**Non-Goals:** in-terminal video playback, sixel/half-block fallback, editing
evidence.

## Decisions

- **Capability detection** comes from the renderer's kitty image transport
  status, never from `TERM` sniffing in the panel.
- **Image sizing.** Fit to the preview area preserving aspect ratio; images
  are fetched via the evidence file route and cached per entry id; switching
  selection cancels in-flight loads.
- **Video.** Show the poster image (inline when supported) and duration/size;
  `Enter` opens the WebM externally.
- **Empty state** shows a neutral message without keybinding hints (per
  AGENTS.md).
- **Keybinds.** `Enter` "open evidence externally" (`short: open`), `y` "copy
  evidence path" (`short: copy`); `j/k` navigation marked `standard`.

## Risks / Trade-offs

- [Large images slow the renderer] → downscale before transmit using the
  renderer's transport; cap preview at panel size.
