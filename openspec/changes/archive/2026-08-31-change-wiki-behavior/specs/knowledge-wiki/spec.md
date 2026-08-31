## MODIFIED Requirements

### Requirement: Dedicated wiki role authors OKF drafts
The system SHALL provide a dedicated agent step and role for documentation in archive-bearing workflows. The wiki role SHALL inspect the change's available repository evidence and the centralized bundle, then write or update meaningful OKF v0.2 concept documents as unverified drafts using project-scoped identifiers. Before choosing a write path, it SHALL search for related concepts using the requested subject and relevant terms, inspect plausible candidates, and select the canonical existing identifier when a candidate covers the intended subject. It SHALL update that concept in place rather than creating an active near-duplicate. It SHALL create a new concept only when no existing concept is the intended subject or when the requested knowledge is materially distinct from all candidates, and its run-bound evidence SHALL explain that distinction. When updating, it SHALL preserve the concept identifier, unrelated body content, unknown frontmatter fields, and applicable provenance/lifecycle metadata while refreshing the requested facts. Each authored concept SHALL include a non-empty type, title, description, source resources, and body content that explains durable facts with repository-relative citations qualified by project context. The role SHALL report every touched concept identifier and whether it was created or updated, or explicitly report that no durable knowledge was found.

#### Scenario: Wiki role writes a draft concept
- **WHEN** the dedicated wiki step identifies durable project knowledge and no existing concept is the intended subject
- **THEN** it writes a new concept under `projects/<project-id>/` with `status: draft`, generated provenance, sources, and no `verified` event

#### Scenario: Wiki role updates the canonical concept first
- **WHEN** a search and inspection of the centralized bundle finds an existing concept covering the requested subject
- **THEN** the wiki role updates that existing identifier in place, preserving unrelated content and unknown frontmatter instead of creating an active near-duplicate

#### Scenario: Wiki role creates only a materially distinct concept
- **WHEN** existing candidates are related but none covers the requested subject, or the requested knowledge is materially distinct from every candidate
- **THEN** the wiki role may create a new project-scoped concept and its run-bound evidence explains why updating an existing candidate would be incorrect

#### Scenario: Wiki role avoids duplicate concepts
- **WHEN** a related concept already exists in the centralized bundle
- **THEN** the wiki role searches and reads candidates, updates the intended existing identifier when it is the canonical subject, and does not create an active near-duplicate merely because a new path or title is convenient

#### Scenario: Wiki role records no-op documentation
- **WHEN** the change contains no durable knowledge worth retaining
- **THEN** the wiki role writes no concept and its evidence explicitly states that no durable knowledge was found

#### Scenario: Draft content follows OKF shape
- **WHEN** a concept is authored by the wiki role
- **THEN** it is a valid UTF-8 Markdown concept with OKF v0.2-compatible frontmatter and meaningful body-level claims tied to source resources
