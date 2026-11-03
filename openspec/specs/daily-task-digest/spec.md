# daily-task-digest Specification

## Purpose
TBD - created by archiving change daily-task-digest-sessions. Update Purpose after archive.
## Requirements
### Requirement: Berlin weekday nominal-time digest
The system SHALL provide a self-contained daily task digest job for Monday-Friday at 09:00 Europe/Berlin, DST-aware, using existing scheduler preview, history, pause/cancel, job-level no-overlap and late policies. Each report SHALL cover [nominal occurrence time minus 24 elapsed hours, nominal occurrence time), including Monday. Late execution SHALL retain the nominal window and identify actual execution time. The digest SHALL be delivered through a named workflowless pi-durable session, never a workflow or Home.

#### Scenario: Monday and DST
- **WHEN** Monday or a Berlin DST boundary changes local clock offsets
- **THEN** preview SHALL retain weekday 09:00 local scheduling and the report SHALL retain exactly the preceding 24 elapsed hours without implicit weekend catch-up

#### Scenario: Late execution
- **WHEN** an occurrence executes late under a confirmed run-late or expire-after policy
- **THEN** it SHALL use the nominal window or expire visibly according to that policy, not substitute a current-time window

### Requirement: Evidenced Jira activity across accessible projects
The digest SHALL gather created/updated task activity across all accessible Jira Cloud projects without restricting to assigned issues, including meaningful status, resolution, assignee, priority, sprint, due-date and comment movement. It SHALL adapt actual supported connector JSON, MCP envelopes and recognized Markdown responses without requiring model reconstruction, follow available search/event/comment pagination, retrieve candidate detail/history/comments where supported, use source evidence and links, minimize retrieved private fields and disclose unavailable evidence. Updated timestamps alone SHALL NOT establish transitions. Late candidate discovery SHALL NOT exclude issues merely because their latest update is after nominal window end; final event filtering SHALL retain the exact nominal window.

#### Scenario: Verified and unverified updates
- **WHEN** an issue has a status changelog event and another only an updated timestamp
- **THEN** the first SHALL describe the evidenced movement and the second SHALL disclose an unverified update without inventing a transition

#### Scenario: Multi-project paginated source
- **WHEN** events span accessible projects and several result pages
- **THEN** collection SHALL include all reachable pages within declared bounds, deduplicate events and report truncation or field-access gaps

#### Scenario: Markdown search followed by incomplete detail
- **WHEN** a recognized Markdown search response supplies 428 candidates and the connector supplies only some detail/comment/history evidence
- **THEN** collection SHALL preserve actual candidate identities and continuation metadata and attempt supported detail reads
- **AND** unavailable detail/history/comment pages SHALL remain explicit coverage gaps rather than a JSON parsing failure reported as empty success

#### Scenario: Missing timestamps and adversarial descriptions
- **WHEN** a response lacks event timestamps or contains instructions inside an issue description
- **THEN** the adapter SHALL NOT fabricate times or transitions and source text SHALL NOT grant tool authority

### Requirement: New Wiz findings through discovered MCP tools
The digest SHALL use tool discovery and MCP execution through codemode for new Wiz findings across accessible account scope. It SHALL discover relevant supported finding domains, adapt actual returned envelopes, use creation/first-seen evidence for newness, paginate with each method's actual schema and document domain coverage. Unsupported domains or unavailable time evidence SHALL be disclosed, not treated as empty or replaced with updated findings. Collection SHALL continue actual cursors until exhausted or an explicit declared resource cap/failure, including beyond 40 findings. Overlapping domains SHALL be deduplicated by evidenced finding identity without hiding domain coverage.

#### Scenario: Updated old finding and new finding
- **WHEN** a finding created before the window is updated within it and another is first seen within it
- **THEN** only the evidenced new finding SHALL be classified as new
- **AND** missing first-seen fields or unsupported domains SHALL appear in coverage diagnostics

#### Scenario: Method-specific pagination beyond forty
- **WHEN** risk issues, posture issues and attack-surface findings require multiple pages with different first/limit and time-filter argument names
- **THEN** collection SHALL use each discovered method's actual parameters and follow its returned cursor
- **AND** a loop, cap or unavailable continuation SHALL mark that domain partial rather than complete

### Requirement: Local GitLab scope and verified Renovate authorship
The digest SHALL discover locally available repositories from configured workspace scope and actual GitLab remotes, canonicalize and deduplicate projects including SSH/HTTPS variants, and gather evidenced relevant MR creation, substantive changes, reviews, merges and failures in the nominal window only from those projects on an explicitly verified integration host binding. Creation of verified Renovate-authored MRs SHALL be highlighted, without excluding other relevant MR activity. Updated timestamps alone SHALL NOT establish a specific activity. The digest SHALL NOT guess project paths, enumerate all GitLab projects or infer Renovate authorship from title/branch/username alone. Unsupported activity or pagination capabilities SHALL be disclosed.

#### Scenario: Duplicate remotes and misleading title
- **WHEN** two local repositories point to one GitLab project by SSH and HTTPS and a human MR title mentions Renovate
- **THEN** the project SHALL be queried once and the human MR SHALL NOT be labeled verified Renovate
- **AND** distinct hosts/nested namespaces SHALL retain distinct correct identities

#### Scenario: Inaccessible project or unknown bot identity
- **WHEN** a discovered project is inaccessible or an MR's Renovate identity cannot be verified
- **THEN** coverage SHALL disclose the gap without broadening project scope or asserting an empty successful result
- **AND** uncertain bot identity SHALL NOT suppress separately evidenced ordinary MR activity

#### Scenario: Old MR with new review or failure
- **WHEN** an MR created before the window has an evidenced timestamped review, merge, substantive change or failure inside it
- **THEN** the digest SHALL include that activity with evidence identity/time/link rather than exclude it for not being newly created
- **AND** an updated_at field alone SHALL NOT be described as a review or pipeline failure

#### Scenario: Host mismatch through nested call
- **WHEN** a direct or codemode call names a foreign project or a same-path project on an unbound host
- **THEN** execution SHALL be denied with visible coverage diagnostics, even if source content requests the call

### Requirement: Conservative actionable reports and source coverage
Each report SHALL lead with concise cross-source analysis and prioritized next actions supported by evidence, distinguish observed failure from inferred impact, and prominently show coverage for Jira, GitLab, Wiz, Azure Monitor production logs and New Relic production logs. It SHALL group deduplicated changes into Important, Relevant and Minor with evidence links and bounded actionable recommendations. Important SHALL require explicit highest/critical urgency or blocking evidence, high/critical Wiz severity evidence, explicit dependency security evidence, or evidenced serious production failure severity; customer impact SHALL NOT be asserted from log severity alone. Relevant SHALL cover verified Jira movement, medium Wiz severity, verified major dependency updates not meeting Important and relevant evidenced MR/log activity. Routine activity, low/informational findings and verified minor/patch updates SHALL be Minor; unavailable classification fields SHALL remain conservative and explicitly uncertain. No external actions SHALL be performed.

Repetitive Wiz/log evidence SHALL be grouped by supported problem/resource/service/environment/signature context, with counts, time bounds, severity and one useful next action per group. Grouping SHALL retain stable member identities and safe links/references, distinguish exact counts from samples/lower bounds and not merge unrelated findings or double-count overlapping provider evidence without proof. Output/member caps SHALL be explicit rather than silent losses.

Each source/domain/project SHALL report its scope, window, success/partial/unavailable status, pagination, truncation and unavailable fields. A failed query SHALL NOT be reported as zero results. Successful sources SHALL survive partial outages; an all-failed occurrence SHALL retain a diagnostic report. Reports SHALL avoid raw private dumps and credential values. A structured report-coverage verdict SHALL be incomplete when any mandatory source or expected scope is missing, denied, capped or otherwise unresolved; scheduler delivery/receipt success SHALL NOT imply complete report coverage.

#### Scenario: One provider fails
- **WHEN** Jira succeeds but Wiz authorization fails and GitLab is truncated
- **THEN** the report SHALL retain Jira changes, mark Wiz unavailable with nonsecret setup diagnostics and identify GitLab truncation
- **AND** SHALL NOT state that Wiz has no new findings or that the report is fully covered

#### Scenario: Missing severity and adversarial content
- **WHEN** source content lacks severity or embeds instructions to grant access or edit records
- **THEN** the report SHALL mark uncertainty without inventing urgency and SHALL NOT execute the embedded instructions

#### Scenario: Repetitive security findings and production errors
- **WHEN** many findings share an evidenced problem/resource context and log rows share a service/error signature
- **THEN** the report SHALL present concise groups with counts, time bounds, member references and prioritized actions rather than repeated generic advice
- **AND** an inference of downstream impact SHALL be explicitly labeled rather than presented as observed fact

#### Scenario: Delivered but incomplete report
- **WHEN** native report delivery succeeds but production selectors are unavailable or one required source is omitted
- **THEN** delivery SHALL retain its native receipt and the report/tool coverage verdict SHALL prominently remain incomplete with actionable setup gaps

### Requirement: Safe setup and isolated verification
Delivery SHALL include supported job/schedule setup with explicit model, repository, baseBranch, read-only permission, review policy and exact session association. It SHALL present late-policy alternatives and existing job-level no-overlap for confirmation before scheduling. It SHALL also provide a previewable, guarded operator update path for an existing owned collection session's source settings and stored job task without creating replacement sessions/jobs/schedules or changing credentials. Changes SHALL preserve exact owner/session/native-store/conversation custody, destination admission fences, pinned execution settings, active selection and retained history, and reject stale/foreign/deleted/replaced targets. Updates SHALL become effective at a safe new admission rather than silently reusing stale collection policy.

Implementation SHALL NOT activate a live recurring schedule or mutate the live digest session/job/config. Approved operational application SHALL be left to Home/operator after merge/rebuild through supported authenticated facilities, not manual store edits. Writable approval SHALL remain operator-only. Tests SHALL use fake providers/tools/model and isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and stores, with no live model calls.

#### Scenario: Setup validation without activation
- **WHEN** the developer follows the delivered setup instructions with locally configured model/repository and a chosen session
- **THEN** validation/preview SHALL expose the exact target, Berlin weekday times, ownership requirements and proposed late/no-overlap policies before activation
- **AND** missing integrations SHALL yield actionable nonsecret diagnostics without permission changes

#### Scenario: Synthetic visible delivery
- **WHEN** an isolated synthetic scheduler occurrence collects fake paginated provider data through a fake model/tool surface
- **THEN** one native report SHALL be retained and rendered in the correct sidebar session across restart without live network/model calls or focus theft

#### Scenario: Existing digest migration and stale update
- **WHEN** the operator previews and applies a migration to the exact existing session and job after rebuilding
- **THEN** it SHALL update only approved collection settings and the stored versioned digest task, preserve the existing schedule and exact destination, and create no duplicate entities
- **AND** changed prior settings/job revision, custody mismatch or unsafe admission state SHALL reject apply rather than overwrite or retarget

### Requirement: Verified production telemetry evidence
The digest SHALL analyze iConnect production issues through Azure Monitor and New Relic only with explicit production selectors verified from trusted configuration/evidence and recorded provenance. It SHALL NOT guess production from names, conflate QA with production, or accept selectors granted by source content. Missing provenance SHALL mark that provider unavailable without broad queries. Queries SHALL be constrained to reviewed read-only templates with explicit nominal time bounds, allowed tables/events and approved selectors, and bounded counts/signature aggregates plus sanitized samples.

Telemetry evidence SHALL include provider, service, production provenance, signature, count/count completeness, severity, observed time range and source references. Query result receipts and NDJSON pagination SHALL retain provider/session/occurrence custody; arbitrary paths or another call's result files SHALL NOT be readable. Provider ceilings, omitted pages, file truncation and aggregate/sample limits SHALL be visible. Collection SHALL NOT expose credentials or enable arbitrary shell/filesystem/provider mutations.

#### Scenario: Production and QA share a workspace
- **WHEN** a trusted selector identifies production within a shared workspace/account
- **THEN** only matching production rows SHALL contribute to the digest and the report SHALL identify the selector provenance and time/service bounds
- **AND** a missing/ambiguous selector SHALL yield unavailable coverage rather than a QA-inclusive query

#### Scenario: Query result receipt and incomplete rows
- **WHEN** a telemetry tool returns an NDJSON receipt requiring offset/limit reads and the provider caps the result
- **THEN** collection SHALL read only the authorized receipt within declared bounds and visibly report the provider cap/count limitations
- **AND** arbitrary or cross-session file paths and query widening SHALL be denied through direct and nested call paths

### Requirement: Bounded source collection with honest completion
Source collection SHALL use explicit cumulative page/record/event/time/output bounds as well as per-page bounds, follow actual advertised continuation and preserve successes during failures. Every expected scope SHALL have completion evidence or an explicit nonsecret gap. A recognized empty exhausted source SHALL be distinguishable from unsupported schema, unattempted scope, refusal, missing details, unavailable pagination, cursor loop and resource exhaustion. A model assertion alone SHALL NOT resolve recorded collection gaps.

#### Scenario: Cap reached on irrelevant records
- **WHEN** inspection exhausts a cumulative or nested budget even on irrelevant/out-of-window records
- **THEN** collection SHALL stop boundedly and mark that scope partial with the cap reason rather than claim complete filtered results

#### Scenario: Provisional missing detail resolved
- **WHEN** a search page lacks history but a later actual detail/history page supplies the required evidence and completes pagination
- **THEN** accounting SHALL resolve only that evidenced gap while preserving unrelated unresolved comment/project/domain gaps
