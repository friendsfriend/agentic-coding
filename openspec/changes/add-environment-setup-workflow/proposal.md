# Proposal

## Why

A fresh app has no build/test/run definitions, and the converted existing apps
still need semantic edits (schema variable, mock-auth profile, OTel wiring).
Writing compose files, run scripts, k8s configs and infra definitions by hand
is the bottleneck the environment features depend on. Agents can author them,
but definitions run arbitrary commands on the developer's machine, so nothing
an agent writes may become runnable without human approval.

## What Changes

- A new **`env-setup` workflow family**:
  `start --workflow env-setup --repo PATH --mode checkout --app IDENT [--task TEXT]`.
  - Repository is read-only evidence (like `wiki`): checkout must stay
    unchanged.
  - `setup.author` (agent, role `env-setup`): writes **drafts** to
    `<config>/.drafts/env-setup/<workflowId>/` mirroring the config layout —
    `apps/build/*`, `apps/run/*`, `apps/compose/*`,
    `apps/kubernetes/<app>-<profile>.k8s.json`, `infrastructure/definitions/*`,
    `infrastructure/compose/*`. While authoring, the agent's `env_*` tools run
    against the drafts via the instance config overlay, so it can build, start
    and browse its own drafts.
  - `setup.validate` (system): template validator + start every drafted run
    target (Docker always; script if drafted; Kubernetes only if drafted and the
    cluster exists) and wait for readiness; failure returns to author with the
    report (bounded 5 rounds).
  - `setup.approval` (developer gate): diff of drafts against live config
    (new/modified files, shared-infra changes highlighted); approve or request
    changes with comment.
  - `setup.promote` (system): atomic copy into the live config with protected
    backup, catalog reload; failure restores the backup.
  - Output `env-setup-report.md` (targets, variables used, mock-auth status,
    OTel status, validation results, follow-ups for the app repo).
- Discovery additionally reads Kubernetes run configs from
  `<config>/apps/kubernetes/<app>-<profile>.k8s.json` (`$APP` paths resolve to
  the checkout), so k8s configs need not live in the app repo.
- Guard: live config dir and repository checkout are fingerprinted before each
  author turn; any change outside the drafts dir puts the workflow in
  `attention-required`.

## Capabilities

### New Capabilities

- `environment-setup-workflow`: env-setup family graph, draft overlay,
  validation, approval diff, atomic promotion, write guard, config-dir k8s
  discovery.

## Impact

- `agent-definitions/instructions/env-setup.md`,
  `src/workflow/definitions/graphs/env-setup.ts`, `src/workflow/steps/env-setup.ts`,
  `registerBuiltins.ts`, `catalog.ts`; overlay support in
  `src/server/actions/discovery.ts` and instance start; promotion in
  `src/server/environment/manager.ts`; approval diff view on the dashboard.
- Depends on `add-environment-instances`, `add-instance-infra-isolation`,
  `template-existing-environment-configs` (validator),
  `add-agent-environment-tools`.
