# Design

## Context

The Environments feature renders apps/infra from the devenv CLI package; the
server publishes events over `/api/events` with gap-detectable envelopes.

## Goals / Non-Goals

**Goals:** see and stop agent instances; understand the queue.

**Non-Goals:** starting agent instances from the TUI, editing caps inline (they
are in Settings).

## Decisions

- **Events.** `environment.instance.{started,stopped,removed,queued,promoted,status}`
  with the instance record as payload; the view keeps a keyed store and
  re-snapshots on a sequence gap.
- **Stop.** Uses the instance remove route (stop + schema drop) for agent
  owners and a plain stop for `user`; confirmation names the owner and notes the
  schema drop.
- **Navigation.** Jump to the workflow dashboard by workflow target (the
  sidebar's resolution rule).
- **Keybinds.** `x` "stop instance" (`short: stop`), `Enter` "open owning
  workflow" (`short: open`); navigation `standard`.

## Risks / Trade-offs

- [Developer stops an instance an agent is using] → the agent's next tool call
  sees `not-running` and may restart; acceptable.
