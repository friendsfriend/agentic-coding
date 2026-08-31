## Why

The dedicated wiki agent is already told to avoid active near-duplicates, but the guidance does not make an update-first decision process explicit enough to reliably keep existing concepts current. This can lead to parallel or replacement entries instead of maintaining the canonical concept, reducing freshness and fragmenting durable knowledge. OKF v0.2 is designed for knowledge that is continuously written and maintained by agents, with provenance and lifecycle metadata preserved across edits.

## What Changes

- Strengthen the dedicated wiki-agent instructions with an explicit update-first workflow: search broadly, inspect likely candidates, identify the canonical subject, and update that concept in place whenever it covers the requested knowledge.
- Define creation as the fallback only when no existing concept is the intended subject, and require the agent to explain why a new concept is distinct when creating one.
- Preserve existing concept identity, unrelated content, unknown frontmatter, provenance, and lifecycle information while refreshing the requested facts; do not create a duplicate merely because a new path or title is convenient.
- Add focused regression coverage for the update-first guidance and the create-only-when-distinct rule.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-wiki`: Make update-first concept selection and the exception for genuinely new concepts an explicit requirement of the dedicated wiki role.

## Impact

- `agent-definitions/instructions/wiki.md` and its generated embedded definition used by the application.
- `openspec/specs/knowledge-wiki/spec.md` and focused wiki instruction tests.
- No CLI surface or OKF file format change is required; the existing path-based write operation already updates a concept when the canonical identifier is selected.
