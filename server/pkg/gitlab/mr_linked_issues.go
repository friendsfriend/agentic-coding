package gitlab

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/friendsfriend/devenv/pkg/issues"
)

// glClosesIssue represents an issue that an MR closes, from GitLab's closes_issues endpoint.
type glClosesIssue struct {
	ID          int    `json:"id"`
	IID         int    `json:"iid"`
	Title       string `json:"title"`
	Description string `json:"description"`
	State       string `json:"state"`
	WebURL      string `json:"web_url"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	Author      struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	Labels    []string `json:"labels"`
	Assignees []struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"assignees"`
	Milestone *struct {
		Title string `json:"title"`
	} `json:"milestone,omitempty"`
}

// convertGLClosesIssue converts a GitLab closes_issue to the unified issues.Issue format.
func convertGLClosesIssue(glIssue glClosesIssue) issues.Issue {
	result := issues.Issue{
		ID:          glIssue.ID,
		IID:         glIssue.IID,
		Title:       glIssue.Title,
		Description: glIssue.Description,
		State:       glIssue.State,
		WebURL:      glIssue.WebURL,
		Labels:      glIssue.Labels,
		Assignees:   glIssue.Assignees,
		Milestone:   glIssue.Milestone,
	}
	result.Author.Name = glIssue.Author.Name
	result.Author.Username = glIssue.Author.Username
	return result
}

// parseIssueRefsFromChangeRequestBody parses an MR description for #123 issue references.
func parseIssueRefsFromChangeRequestBody(body string) []int {
	re := regexp.MustCompile(`#(\d+)\b`)
	matches := re.FindAllStringSubmatch(body, -1)
	seen := make(map[int]bool)
	var refs []int
	for _, m := range matches {
		if len(m) >= 2 {
			num, err := strconv.Atoi(m[1])
			if err != nil {
				continue
			}
			if !seen[num] {
				seen[num] = true
				refs = append(refs, num)
			}
		}
	}
	return refs
}

// fetchClosesIssues calls GitLab's closes_issues API for an MR.
func (ic *IssuesClient) fetchClosesIssues(proj *ProjectInfo, mrIID int) ([]issues.Issue, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/closes_issues",
		ic.c.baseURL, projectPath, mrIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch closes_issues: %w", err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab API error (status %d): %s", statusCode, string(body))
	}

	var glIssues []glClosesIssue
	if err := json.Unmarshal(body, &glIssues); err != nil {
		return nil, fmt.Errorf("failed to parse closes_issues: %w", err)
	}

	results := make([]issues.Issue, 0, len(glIssues))
	for _, glI := range glIssues {
		results = append(results, convertGLClosesIssue(glI))
	}

	return results, nil
}

// fetchIssueByIID fetches a GitLab issue by IID to verify it exists.
func (ic *IssuesClient) fetchIssueByIID(proj *ProjectInfo, issueIID int) (*issues.Issue, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/issues/%d",
		ic.c.baseURL, projectPath, issueIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch issue #%d: %w", issueIID, err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab API error (status %d): %s", statusCode, string(body))
	}

	var glIss glIssue
	if err := json.Unmarshal(body, &glIss); err != nil {
		return nil, fmt.Errorf("failed to parse issue: %w", err)
	}

	result := convertGLIssue(glIss)
	return &result, nil
}

// GetChangeRequestLinkedIssues returns issues linked to a change request.
// It combines results from the closes_issues API and #123 refs in the MR description.
func (ic *IssuesClient) GetChangeRequestLinkedIssues(proj *ProjectInfo, mrIID int) ([]issues.Issue, error) {
	seen := make(map[int]bool)
	var results []issues.Issue

	// Source 1: closes_issues API
	closedIssues, err := ic.fetchClosesIssues(proj, mrIID)
	if err != nil {
		log.Printf("[WARN] GitLab GetChangeRequestLinkedIssues: failed to fetch closes_issues for !%d: %v", mrIID, err)
		closedIssues = nil
	}
	for _, iss := range closedIssues {
		if !seen[iss.IID] {
			seen[iss.IID] = true
			results = append(results, iss)
		}
	}

	// Source 2: Parse MR description for #123 references
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d",
		ic.c.baseURL,
		url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project)),
		mrIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err == nil && statusCode == http.StatusOK {
		var mrDetail struct {
			Description string `json:"description"`
		}
		if err := json.Unmarshal(body, &mrDetail); err == nil && mrDetail.Description != "" {
			refs := parseIssueRefsFromChangeRequestBody(mrDetail.Description)
			debugLog("GitLab GetChangeRequestLinkedIssues(!%d): %d closes_issues, %d inline refs", mrIID, len(closedIssues), len(refs))
			for _, refIID := range refs {
				if seen[refIID] {
					continue
				}
				iss, err := ic.fetchIssueByIID(proj, refIID)
				if err != nil {
					log.Printf("[WARN] GitLab GetChangeRequestLinkedIssues: failed to fetch inline issue #%d: %v", refIID, err)
					continue
				}
				seen[refIID] = true
				results = append(results, *iss)
			}
		}
	} else {
		log.Printf("[WARN] GitLab GetChangeRequestLinkedIssues: failed to fetch MR !%d body: %v", mrIID, err)
	}

	return results, nil
}
