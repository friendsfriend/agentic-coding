# Tasks — workflow-tui-cleanups

## Otel viewer dedupe (R6)

- [ ] **T1** Extract `TraceBrowser`, `traces`, and `receiver` into one shared module.
- [ ] **T2** Consume the shared module from both the dashboard trace tab and the standalone `otel-tui` binary; delete the duplicated copy in `agent-dash`.
- [ ] **T3** Confirm trace viewing is unchanged in both surfaces.

## Agent name consistency (R7)

- [ ] **T4** Route both the Herdr agent name and pi `--name` through one naming helper with a single truncation rule so they agree for a given `{change}-{role}`.
- [ ] **T5** Add a test asserting the two names match (including the long-`changeId` truncation case).

## Remove legacy paths (R8)

- [ ] **T6** Remove `startWorkflowWizard` and `pi_command` and any now-unreferenced helpers; confirm no remaining call sites.

## Validation

- [ ] **T7** Run `openspec validate workflow-tui-cleanups` and resolve structural errors.
