package github

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// RepoInfo holds owner and repository name extracted from a GitHub URL
type RepoInfo struct {
	Owner string
	Repo  string
}

// ToChangeRequest converts github.RepoInfo to changerequest.RepoInfo.
func (r *RepoInfo) ToChangeRequest() *changerequest.RepoInfo {
	return &changerequest.RepoInfo{
		Owner: r.Owner,
		Repo:  r.Repo,
		Host:  "github.com",
	}
}

// FromChangeRequest converts changerequest.RepoInfo to github.RepoInfo.
func FromChangeRequest(info *changerequest.RepoInfo) (*RepoInfo, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}
	if info.Owner == "" || info.Repo == "" {
		return nil, fmt.Errorf("changerequest.RepoInfo missing Owner or Repo fields")
	}
	return &RepoInfo{
		Owner: info.Owner,
		Repo:  info.Repo,
	}, nil
}

// ExtractRepoInfo extracts owner/repo from a GitHub repository URL.
// Supports HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git) formats.
func ExtractRepoInfo(gitURL string) (*RepoInfo, error) {
	if gitURL == "" {
		return nil, fmt.Errorf("empty Git URL")
	}

	gitURL = strings.TrimSpace(gitURL)

	var ownerRepo string

	if strings.HasPrefix(gitURL, "git@github.com:") {
		// SSH: git@github.com:owner/repo.git
		ownerRepo = strings.TrimPrefix(gitURL, "git@github.com:")
		ownerRepo = strings.TrimSuffix(ownerRepo, ".git")
	} else if strings.HasPrefix(gitURL, "https://github.com/") || strings.HasPrefix(gitURL, "http://github.com/") {
		// HTTPS: https://github.com/owner/repo.git
		parsed, err := url.Parse(gitURL)
		if err != nil {
			return nil, fmt.Errorf("failed to parse GitHub URL: %w", err)
		}
		ownerRepo = strings.TrimPrefix(parsed.Path, "/")
		ownerRepo = strings.TrimSuffix(ownerRepo, ".git")
	} else {
		return nil, fmt.Errorf("not a GitHub URL: %s", gitURL)
	}

	parts := strings.SplitN(ownerRepo, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, fmt.Errorf("invalid GitHub URL format (expected owner/repo): %s", gitURL)
	}

	return &RepoInfo{
		Owner: parts[0],
		Repo:  parts[1],
	}, nil
}

// SearchResult represents a repository found via GitHub search.
// Field names and JSON tags match the GitLab SearchResult so the server
// can return a unified shape to the TUI.
type SearchResult struct {
	Name          string `json:"name"`
	FullPath      string `json:"fullPath"`
	HTTPURL       string `json:"httpUrl"`
	DefaultBranch string `json:"defaultBranch"`
}

// --- Public API methods ---

// Search implements changerequest.Client.Search.
func (c *client) Search(info *changerequest.RepoInfo, query string, limit int) ([]changerequest.SearchResult, error) {
	limit = clampProviderLimit(limit)

	params := url.Values{}
	params.Set("q", query)
	params.Set("per_page", fmt.Sprintf("%d", limit))
	params.Set("sort", "updated")

	apiURL := fmt.Sprintf("https://api.github.com/search/repositories?%s", params.Encode())

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var searchResp struct {
		Items []struct {
			Name          string `json:"name"`
			FullName      string `json:"full_name"`
			CloneURL      string `json:"clone_url"`
			DefaultBranch string `json:"default_branch"`
		} `json:"items"`
	}

	if err := json.Unmarshal(body, &searchResp); err != nil {
		return nil, fmt.Errorf("failed to parse search response: %w", err)
	}

	results := make([]changerequest.SearchResult, 0, len(searchResp.Items))
	for _, item := range searchResp.Items {
		results = append(results, changerequest.SearchResult{
			Name:          item.Name,
			FullPath:      item.FullName,
			HTTPURL:       item.CloneURL,
			DefaultBranch: item.DefaultBranch,
		})
	}

	return results, nil
}
