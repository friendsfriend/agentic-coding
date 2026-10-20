## ADDED Requirements

### Requirement: Screenshots can be stored without being viewed
`browser_screenshot` SHALL accept `view: false` together with `evidence: true`; the screenshot SHALL be stored as evidence and the tool result SHALL name the evidence id and caption without returning the image. `view: false` without `evidence: true` SHALL be refused. On a stage-bound session, stored screenshots SHALL count against the stage's `limits.maxScreenshots` per workflow, and a screenshot beyond it SHALL be refused with `stage-screenshot-limit` without storing anything.

#### Scenario: Evidence without context cost
- **WHEN** an agent calls `browser_screenshot({ evidence: true, view: false, caption: "Request in clerk inbox" })`
- **THEN** the screenshot SHALL be stored and the result SHALL contain its evidence id and no image

#### Scenario: Screenshot cap
- **WHEN** a workflow has stored `maxScreenshots` screenshots on a stage and asks for another with `evidence: true`
- **THEN** the call SHALL be refused with `stage-screenshot-limit`

### Requirement: Recording keeps the session's sessionStorage
When a recording starts, the recording context SHALL receive the cookies and localStorage of the session (as today) and the sessionStorage of the current page's origin, installed before the current URL is re-opened, so an application that keeps its login in sessionStorage stays logged in.

#### Scenario: SPA login survives recording
- **WHEN** a session is logged in to an application that keeps its token in sessionStorage and the agent starts a recording
- **THEN** the re-opened page in the recording context SHALL be logged in
