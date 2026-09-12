package gitlab

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// ProjectInfo represents extracted project information from a Git URL
type ProjectInfo struct {
	Host      string
	Namespace string // Group/organization name
	Project   string // Project name
}

// ToChangeRequest converts gitlab.ProjectInfo to changerequest.RepoInfo.
func (p *ProjectInfo) ToChangeRequest() *changerequest.RepoInfo {
	return &changerequest.RepoInfo{
		Host:      p.Host,
		Namespace: p.Namespace,
		Project:   p.Project,
	}
}

// FromChangeRequest converts changerequest.RepoInfo to gitlab.ProjectInfo.
func FromChangeRequest(info *changerequest.RepoInfo) (*ProjectInfo, error) {
	if info == nil {
		return nil, fmt.Errorf("project info is nil")
	}
	if info.Namespace == "" || info.Project == "" {
		return nil, fmt.Errorf("changerequest.RepoInfo missing Namespace or Project fields")
	}
	return &ProjectInfo{
		Host:      info.Host,
		Namespace: info.Namespace,
		Project:   info.Project,
	}, nil
}

// SearchResult represents a repository found via project search
type SearchResult struct {
	Name          string `json:"name"`
	FullPath      string `json:"fullPath"`
	HTTPURL       string `json:"httpUrl"`
	DefaultBranch string `json:"defaultBranch"`
}

// ExtractProjectInfo extracts GitLab project information from a Git repository URL
func ExtractProjectInfo(gitURL string) (*ProjectInfo, error) {
	if gitURL == "" {
		return nil, fmt.Errorf("empty Git URL")
	}

	// Trim whitespace
	gitURL = strings.TrimSpace(gitURL)

	var host, projectPath string

	// Handle SSH format: git@hostname:group/project.git
	if strings.HasPrefix(gitURL, "git@") {
		parts := strings.SplitN(gitURL, ":", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid SSH Git URL format: %s", gitURL)
		}

		host = strings.TrimPrefix(parts[0], "git@")
		projectPath = strings.TrimSuffix(parts[1], ".git")
	} else if strings.HasPrefix(gitURL, "https://") || strings.HasPrefix(gitURL, "http://") {
		// Handle HTTPS/HTTP format: https://hostname/group/project.git
		parsedURL, err := url.Parse(gitURL)
		if err != nil {
			return nil, fmt.Errorf("failed to parse Git URL: %w", err)
		}

		host = parsedURL.Host
		projectPath = strings.TrimPrefix(parsedURL.Path, "/")
		projectPath = strings.TrimSuffix(projectPath, ".git")
	} else {
		return nil, fmt.Errorf("unsupported Git URL format: %s", gitURL)
	}

	// Validate host and project path
	if host == "" || projectPath == "" {
		return nil, fmt.Errorf("could not extract host and project path from URL: %s", gitURL)
	}

	// Split project path into namespace and project
	pathParts := strings.SplitN(projectPath, "/", 2)
	if len(pathParts) != 2 {
		return nil, fmt.Errorf("invalid project path format (expected group/project): %s", projectPath)
	}

	return &ProjectInfo{
		Host:      host,
		Namespace: pathParts[0],
		Project:   pathParts[1],
	}, nil
}

// SearchProjects searches for GitLab projects the authenticated user has access to.
func (c *client) SearchProjects(query string, limit int) ([]SearchResult, error) {
	limit = clampProviderLimit(limit)

	params := url.Values{}
	params.Set("search", query)
	params.Set("membership", "true")
	params.Set("per_page", fmt.Sprintf("%d", limit))
	params.Set("order_by", "last_activity_at")

	apiURL := fmt.Sprintf("%s/api/v4/projects?%s", c.baseURL, params.Encode())

	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var projects []struct {
		Name              string `json:"name"`
		PathWithNamespace string `json:"path_with_namespace"`
		HTTPURLToRepo     string `json:"http_url_to_repo"`
		DefaultBranch     string `json:"default_branch"`
	}

	if err := json.Unmarshal(body, &projects); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	results := make([]SearchResult, 0, len(projects))
	for _, p := range projects {
		results = append(results, SearchResult{
			Name:          p.Name,
			FullPath:      p.PathWithNamespace,
			HTTPURL:       p.HTTPURLToRepo,
			DefaultBranch: p.DefaultBranch,
		})
	}

	return results, nil
}
