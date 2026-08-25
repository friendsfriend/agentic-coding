## Context

The home dashboard (`Home`) currently renders the workspace list and handles home-level keybindings, while the detail dashboard (`App`) already derives Git health from a workflow worktree and opens changed files through `ChangedFilesView`. Home data is loaded by the shell through `listWorkflows()` and refreshed on a timer/filesystem changes. The new overview feature must work for the selected workflow without adding persisted state, an external Git dependency, or a second changed-file interaction.

## Goals / Non-Goals

**Goals:**

- Show the selected workspace's working-tree counts for changed, added, and deleted files and its ahead/behind commit counts.
- Keep Git inspection best-effort so a missing worktree, missing upstream, or non-Git state produces an explicit unavailable/no-upstream display rather than breaking the overview.
- Make `G` open the same changed-file list and diff interaction used by the detail dashboard's existing Git panel.
- Refresh overview Git data along with the existing workspace refresh.

**Non-Goals:**

- No changes to workflow state, Git branches, commits, remotes, or external APIs.
- No lazygit launch and no developer-review approval/comment workflow from the overview.
- No replacement of the existing detail-dashboard Git panel.

## Decisions

1. **Use the workflow worktree as the Git source.** Each overview item already exposes the workflow state and worktree; status must describe the files users will see when opening that workflow, not the process checkout that discovered it. The status helper will run Git commands in that worktree and return a typed result with an unavailable reason when commands fail.

2. **Centralize status calculation and reuse it for overview data.** Add a small dashboard data helper that parses porcelain status into distinct changed/added/deleted file counts and calculates upstream ahead/behind counts with the same `rev-list` semantics as the detail dashboard. `listWorkflows()` will attach the result to each `WorkflowOverview`; the detail dashboard can consume the same helper so the two panels cannot drift. An absent upstream is represented separately from a numeric zero.

3. **Render status for the selected overview row.** The home view will retain its workspace selection and render a compact Git status panel adjacent to or below the list. With no selected row it will show that no workspace is selected; with unavailable Git data it will show the reason. The panel will include branch name and labeled counts so zero values are unambiguous.

4. **Extract the existing changed-file browser boundary instead of duplicating it.** Keep `ChangedFilesView` as the shared presentational list and factor the surrounding list-to-diff modal behavior currently owned by the detail dashboard into a reusable dashboard component/controller. The home `G` handler will load the selected workflow's existing local changes, open that component, and let its existing Enter/Escape/search/diff behavior operate. Detail-dashboard developer review remains the owner of review comments and approval-specific actions.

5. **Treat `G` as a home-only action and document it.** Register `g` in the home keymap and add it to the overview help. It is ignored when there is no selected workflow, and loading errors are surfaced through the existing home error dialog/notification path. Existing home navigation and modal key priority remain unchanged.

## Risks / Trade-offs

- [Risk] Git status commands run once per discovered workflow and can make a large overview refresh slower. → Mitigation: use short, bounded Git commands, compute status during the existing refresh, and avoid additional polling beyond the current refresh cadence.
- [Risk] Porcelain status contains staged and unstaged entries, renames, and untracked paths that can be double-counted. → Mitigation: parse porcelain records into a path-keyed set and define classification precedence in tests; keep workflow metadata excluded consistently with changed-file loading.
- [Risk] A worktree can disappear while the overview is rendering or while `G` loads files. → Mitigation: return an unavailable status and show the existing error surface; do not crash or mutate workflow state.
- [Risk] Sharing modal behavior with developer review could regress review-specific key handling. → Mitigation: keep review callbacks (findings, comments, finish gating) at the detail-dashboard layer and add regression coverage for both home `G` and detail-panel Enter.
