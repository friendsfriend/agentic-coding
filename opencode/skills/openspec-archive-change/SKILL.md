---

name: openspec-archive-change
description: "Archive a completed change in the experimental workflow. Use when the user wants to finalize and archive a change after implementation is complete."
---

Archive a completed change in the experimental workflow.

**Input**: The assignment must specify a change name. If it is missing, stop and report the available changes; do not guess.

**Steps**

1. **Require a change name**

   The assignment must name the change. If it does not, run `openspec list --json`
   and stop, reporting the available changes. Do not guess or auto-select.

2. **Check artifact completion status**

   Run `openspec status --change "<name>" --json` to check artifact completion.

   Parse the JSON to understand:
   - `schemaName`: The workflow being used
   - `artifacts`: List of artifacts with their status (`done` or other)

   **If any artifacts are not `done`:**
   - List the incomplete artifacts
   - Stop and report that the archive is blocked; the caller must decide

3. **Check task completion status**

   Read the tasks file (typically `tasks.md`) to check for incomplete tasks.

   Count tasks marked with `- [ ]` (incomplete) vs `- [x]` (complete).

   **If incomplete tasks found:**
   - Report the count and list of incomplete tasks
   - Stop and report that the archive is blocked; the caller must decide

   **If no tasks file exists:** Proceed without task-related warning.

4. **Assess delta spec sync state**

   Check for delta specs at `openspec/changes/<name>/specs/`. If none exist, proceed without syncing.

   **If delta specs exist:**
   - Compare each delta spec with its corresponding main spec at `openspec/specs/<capability>/spec.md`
   - Determine what changes would be applied (adds, modifications, removals, renames)
   - Show a combined summary before syncing

   **Sync authority:**
   - The caller must authorize sync. In the OpenSpec workflow, the orchestrator
     authorizes it explicitly.
   - If sync is authorized, load the `openspec-sync-specs` skill and perform the
     sync in this session before archiving.
   - If sync is not authorized, stop and report that the archive is blocked.
   - A failed sync blocks archive; do not silently skip it.

5. **Perform the archive**

   Create the archive directory if it doesn't exist:
   ```bash
   mkdir -p openspec/changes/archive
   ```

   Generate target name using current date: `YYYY-MM-DD-<change-name>`

   **Check if target already exists:**
   - If yes: Fail with error, suggest renaming existing archive or using different date
   - If no: Move the change directory to archive

   ```bash
   mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>
   ```

6. **Display summary**

   Show archive completion summary including:
   - Change name
   - Schema that was used
   - Archive location
   - Whether specs were synced (if applicable)
   - Note about any warnings (incomplete artifacts/tasks)

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** openspec/changes/archive/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced to main specs (or "No delta specs" or "Sync skipped")

All artifacts complete. All tasks complete.
```

**Guardrails**
- Require the assignment to name the change; otherwise stop and report the choices
- Use artifact graph (openspec status --json) for completion checking
- Don't block archive on warnings - just inform and confirm
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If sync is authorized, use the openspec-sync-specs skill in this session
- If delta specs exist, always run the sync assessment and show the combined summary before syncing
