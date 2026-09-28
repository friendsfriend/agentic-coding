# Proposal

## Why

The change-request AI review is superseded. It existed to give a merge/pull
request an automated first-pass review: the server created a throwaway detached
checkout of the source branch, spawned `pi` inside it, streamed the review to
the devenv UI, and let the agent post inline comments back over a token-scoped
callback route. Agentic workflows now own review work — they run the agents,
keep the worktree, and record the findings — so the feature has no user, and it
is the only reason the server created a worktree outside the worktree port.

It is also the reason for the one route whose authorization is not the instance
bearer token: a spawned agent is handed a URL and must not receive the instance
capability. Removing the feature removes that exception and the review-shaped
worktree handling with it.

## What Changes

- Delete the change-request review stream (`POST /api/ai/cr-review-stream`) and
  its comment callback (`POST /api/ai/cr-comment-callback/{token}`) routes from
  the route manifest, the AI dispatcher and the public surface.
- Delete `src/server/integrations/cr-review.ts` in full: the temporary
  checkout, the Pi RPC event mapping, the scoped callback registry, the token
  generation, the comment submission and the GitLab review target resolver.
- Delete the path-capability authorization exemption: every route requires the
  instance bearer token again.
- Delete the devenv UI surface: the review overlay, its store state, its
  keybind, the CR detail key handling for it, the review prompt builder, and the
  SSE client that called the stream route.
- Remove the `analyze-logs` sibling surface's dead code paths and update the
  integration documentation and the capability specification.
- Keep Pi session discovery and log analysis unchanged.

## Capabilities

### Modified Capabilities

- `bun-development-integrations`: the scoped AI streaming requirement keeps Pi
  session discovery and streamed log analysis and no longer requires or permits
  a change-request review stream, its callback, or its temporary checkout.

## Impact

The change deletes a server route family, its authorization exception, a
server module, a devenv overlay and its client stream, and the tests that
exercised the checkout lifecycle and callback scoping. Pi session discovery and
log analysis (routes, tests, docs) are unchanged. No remaining route answers
without the instance bearer token, and no server code path creates a worktree
other than the worktree port's `ensure`/`createDetached`. A developer's own
devenv configuration that still calls the removed stream route will see the
route 404; nothing else in the product depends on it.
