package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Project availability values. An entry never disappears because its checkout
// is missing: the configured identity stays visible and reports why it cannot
// be used.
const (
	ProjectAvailable   = "available"
	ProjectMissing     = "missing"
	ProjectInvalid     = "invalid"
	ProjectUnresolved  = "unresolved"
	ProjectKindApp     = "app"
	ProjectKindLibrary = "library"
)

// ProjectCapabilities describes what the catalog could observe for a project.
// Capability reads are bounded to the configured/selected checkout and never
// mutate it.
type ProjectCapabilities struct {
	OpenSpec bool `json:"openspec"`
}

// Project is the canonical discovery projection for a configured app or
// library. It deliberately separates the stable configured identity from the
// resolved Git repository (shared by every linked worktree) and the active
// checkout that repository work should currently use.
type Project struct {
	Ident          string              `json:"ident"`
	DisplayName    string              `json:"displayName"`
	Kind           string              `json:"kind"`
	CanonicalRoot  string              `json:"canonicalRoot,omitempty"`
	ActiveCheckout string              `json:"activeCheckout,omitempty"`
	Available      bool                `json:"available"`
	Availability   string              `json:"availability"`
	Detail         string              `json:"detail,omitempty"`
	Capabilities   ProjectCapabilities `json:"capabilities"`
}

// ProjectCatalog is the wire envelope for GET /api/projects and the bounded
// catalog CLI invocation.
type ProjectCatalog struct {
	Revision string    `json:"revision"`
	Projects []Project `json:"projects"`
}

// GetProjectCatalog projects the configured apps/libraries into the canonical
// catalog. Duplicate configured identifiers are rejected with diagnostics
// rather than silently collapsed.
func (am *appManager) GetProjectCatalog() ([]Project, error) {
	am.mu.Lock()
	defer am.mu.Unlock()
	return BuildProjectCatalog(am.apps)
}

// BuildProjectCatalog is the pure projection helper shared by the manager and
// the server (which keeps its own app snapshot).
func BuildProjectCatalog(apps []App) ([]Project, error) {
	seen := make(map[string]struct{}, len(apps))
	projects := make([]Project, 0, len(apps))
	for _, a := range apps {
		ident := strings.TrimSpace(a.Ident)
		if ident == "" {
			continue
		}
		if _, duplicate := seen[ident]; duplicate {
			return nil, fmt.Errorf("duplicate configured project ident %q", ident)
		}
		seen[ident] = struct{}{}
		projects = append(projects, projectFromApp(a))
	}
	sort.Slice(projects, func(i, j int) bool {
		return projects[i].Ident < projects[j].Ident
	})
	return projects, nil
}

// CatalogRevision returns a stable fingerprint of the projected catalog so
// consumers can detect a configured-project change without diffing entries.
func CatalogRevision(projects []Project) string {
	data, err := json.Marshal(projects)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16]
}

// NewProjectCatalog wraps the projection with its revision.
func NewProjectCatalog(projects []Project) ProjectCatalog {
	return ProjectCatalog{Revision: CatalogRevision(projects), Projects: projects}
}

func projectFromApp(a App) Project {
	kind := ProjectKindApp
	if a.AppType == TypeLIB {
		kind = ProjectKindLibrary
	}
	project := Project{
		Ident:          a.Ident,
		DisplayName:    a.DisplayName,
		Kind:           kind,
		ActiveCheckout: a.LocalDirectoryPath,
		Availability:   ProjectUnresolved,
	}
	if project.ActiveCheckout == "" {
		project.Detail = "no managed checkout path is known"
		return project
	}

	info, statErr := os.Stat(project.ActiveCheckout)
	switch {
	case statErr != nil:
		project.Availability = ProjectMissing
		project.Detail = "checkout is not cloned at the expected managed location"
		return project
	case !info.IsDir():
		project.Availability = ProjectInvalid
		project.Detail = "checkout path exists but is not a directory"
		return project
	}

	root, err := resolveCanonicalRoot(project.ActiveCheckout)
	if err != nil {
		project.Availability = ProjectInvalid
		project.Detail = err.Error()
		project.Capabilities.OpenSpec = openspecConfigured(project.ActiveCheckout)
		return project
	}

	project.CanonicalRoot = root
	project.Available = true
	project.Availability = ProjectAvailable
	project.Capabilities.OpenSpec = openspecConfigured(root) || openspecConfigured(project.ActiveCheckout)
	return project
}

// openspecConfigured is a bounded read of a project's OpenSpec configuration.
// It never creates or modifies anything.
func openspecConfigured(root string) bool {
	if root == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(root, "openspec", "config.yaml"))
	return err == nil && !info.IsDir()
}

// resolveCanonicalRoot resolves the shared Git repository root for a checkout,
// preserving linked-worktree semantics: every worktree of one repository
// resolves to the same canonical root.
func resolveCanonicalRoot(checkout string) (string, error) {
	if checkout == "" {
		return "", fmt.Errorf("no checkout path")
	}
	commonDir, err := gitRevParse(checkout, "--path-format=absolute", "--git-common-dir")
	if err != nil {
		// Older Git without --path-format: resolve the relative common dir
		// against the checkout ourselves.
		raw, fallbackErr := gitRevParse(checkout, "--git-common-dir")
		if fallbackErr != nil {
			return "", fmt.Errorf("not a Git repository: %w", err)
		}
		commonDir = strings.TrimSpace(raw)
		if !filepath.IsAbs(commonDir) {
			commonDir = filepath.Join(checkout, commonDir)
		}
	}
	commonDir = strings.TrimSpace(commonDir)
	if commonDir == "" {
		return "", fmt.Errorf("Git common directory could not be resolved")
	}
	absolute, err := filepath.Abs(commonDir)
	if err != nil {
		return "", fmt.Errorf("Git common directory is not resolvable: %w", err)
	}
	if filepath.Base(absolute) == ".git" {
		return filepath.Dir(absolute), nil
	}
	return absolute, nil
}

func gitRevParse(dir string, args ...string) (string, error) {
	command := append([]string{"-C", dir, "rev-parse"}, args...)
	out, err := exec.Command("git", command...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
