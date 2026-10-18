## ADDED Requirements

### Requirement: Browser tool outputs carry no declared secret
Every browser route response returned to an agent — open, snapshot, action, wait, eval, console, network, screenshot metadata, recording, script result and every error message — SHALL pass through the shared environment redactor (every non-empty value of the configuration root `.env`, plus the resolved credentials and their URL-encoded forms for a stage-bound session) before it leaves the server. Every URL in such a response SHALL have the values of token-like query and fragment parameters (`token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`, `session`, `sid`, `sig`, `signature`, `password`, `secret`, `key`, `auth`, case-insensitive) replaced by a redaction marker. This SHALL apply to every session, whether stage-bound or not.

#### Scenario: Secret in page text
- **WHEN** a page renders a string equal to a `.env` value and an agent calls `browser_snapshot`
- **THEN** the snapshot SHALL contain a redaction marker instead of the value

#### Scenario: Token in a URL
- **WHEN** a session lands on `https://app.example.com/callback#access_token=abc123&state=xyz`
- **THEN** the URL in the tool result SHALL NOT contain `abc123` or `xyz`

#### Scenario: Eval returns an input value
- **WHEN** an agent evaluates JavaScript that returns the value of a field filled by `stage_login`
- **THEN** the result SHALL contain a redaction marker instead of the credential
