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
The digest SHALL gather created/updated task activity across all accessible Jira Cloud projects without restricting to assigned issues, including meaningful status, assignee, priority and comment movement. It SHALL follow available search/event/comment pagination, use source evidence and links, minimize retrieved private fields and disclose unavailable evidence. Updated timestamps alone SHALL NOT establish transitions.

#### Scenario: Verified and unverified updates
- **WHEN** an issue has a status changelog event and another only an updated timestamp
- **THEN** the first SHALL describe the evidenced movement and the second SHALL disclose an unverified update without inventing a transition

#### Scenario: Multi-project paginated source
- **WHEN** events span accessible projects and several result pages
- **THEN** collection SHALL include all reachable pages within declared bounds, deduplicate events and report truncation or field-access gaps

### Requirement: New Wiz findings through discovered MCP tools
The digest SHALL use tool discovery and MCP execution through codemode for new Wiz findings across accessible account scope. It SHALL discover relevant supported finding domains, use creation/first-seen evidence for newness, paginate and document domain coverage. Unsupported domains or unavailable time evidence SHALL be disclosed, not treated as empty or replaced with updated findings.

#### Scenario: Updated old finding and new finding
- **WHEN** a finding created before the window is updated within it and another is first seen within it
- **THEN** only the evidenced new finding SHALL be classified as new
- **AND** missing first-seen fields or unsupported domains SHALL appear in coverage diagnostics

### Requirement: Local GitLab scope and verified Renovate authorship
The digest SHALL discover locally available repositories from configured workspace scope and actual GitLab remotes, canonicalize and deduplicate projects including SSH/HTTPS variants, and gather only newly created Renovate-authored MRs in the window from those projects. It SHALL NOT guess project paths, enumerate all GitLab projects or infer Renovate authorship from title/branch alone.

#### Scenario: Duplicate remotes and misleading title
- **WHEN** two local repositories point to one GitLab project by SSH and HTTPS and a human MR title mentions Renovate
- **THEN** the project SHALL be queried once and the human MR SHALL NOT be included as Renovate
- **AND** distinct hosts/nested namespaces SHALL retain distinct correct identities

#### Scenario: Inaccessible project or unknown bot identity
- **WHEN** a discovered project is inaccessible or an MR's Renovate identity cannot be verified
- **THEN** coverage SHALL disclose the gap without broadening project scope or asserting an empty successful result

### Requirement: Conservative actionable reports and source coverage
Each report SHALL group deduplicated changes into Important, Relevant and Minor with evidence links and bounded actionable recommendations. Important SHALL require explicit highest/critical urgency or blocking evidence, high/critical Wiz severity evidence, or explicit dependency security evidence. Relevant SHALL cover verified Jira movement, medium Wiz severity or verified major dependency updates not meeting Important. Routine activity, low/informational findings and verified minor/patch updates SHALL be Minor; unavailable classification fields SHALL remain conservative and explicitly uncertain. No external actions SHALL be performed.

Each source/domain/project SHALL report its scope, window, success/partial/unavailable status, pagination, truncation and unavailable fields. A failed query SHALL NOT be reported as zero results. Successful sources SHALL survive partial outages; an all-failed occurrence SHALL retain a diagnostic report. Reports SHALL avoid raw private dumps and credential values.

#### Scenario: One provider fails
- **WHEN** Jira succeeds but Wiz authorization fails and GitLab is truncated
- **THEN** the report SHALL retain Jira changes, mark Wiz unavailable with nonsecret setup diagnostics and identify GitLab truncation
- **AND** SHALL NOT state that Wiz has no new findings

#### Scenario: Missing severity and adversarial content
- **WHEN** source content lacks severity or embeds instructions to grant access or edit records
- **THEN** the report SHALL mark uncertainty without inventing urgency and SHALL NOT execute the embedded instructions

### Requirement: Safe setup and isolated verification
Delivery SHALL include supported job/schedule setup with explicit model, repository, baseBranch, read-only permission, review policy and exact session association. It SHALL present late-policy alternatives and existing job-level no-overlap for confirmation before scheduling. Implementation SHALL NOT activate a live recurring schedule or run account-wide live collection. Tests SHALL use fake providers/tools/model and isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR, HERDR_WIKI_DIR and stores.

#### Scenario: Setup validation without activation
- **WHEN** the developer follows the delivered setup instructions with locally configured model/repository and a chosen session
- **THEN** validation/preview SHALL expose the exact target, Berlin weekday times, ownership requirements and proposed late/no-overlap policies before activation
- **AND** missing integrations SHALL yield actionable nonsecret diagnostics without permission changes

#### Scenario: Synthetic visible delivery
- **WHEN** an isolated synthetic scheduler occurrence collects fake paginated provider data through a fake model/tool surface
- **THEN** one native report SHALL be retained and rendered in the correct sidebar session across restart without live network/model calls or focus theft
