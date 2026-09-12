package gitlab

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
	"github.com/friendsfriend/devenv/pkg/issues"
)

// glClosedByMR represents a GitLab change request returned by the closed_by endpoint.
type glClosedByMR struct {
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
	SourceBranch   string `json:"source_branch"`
	TargetBranch   string `json:"target_branch"`
	MergeStatus    string `json:"merge_status"`
	Draft          bool   `json:"draft"`
	WorkInProgress bool   `json:"work_in_progress"`
	HasConflicts   bool   `json:"has_conflicts"`
	HeadPipeline   *struct {
		ID     int    `json:"id"`
		Status string `json:"status"`
		WebURL string `json:"web_url"`
	} `json:"head_pipeline,omitempty"`
	BlockingDiscussionsResolved bool `json:"blocking_discussions_resolved"`
}

// convertGLClosedByMR converts a GitLab closed_by MR to the unified changerequest.ChangeRequest format.
func convertGLClosedByMR(glMR glClosedByMR) changerequest.ChangeRequest {
	result := changerequest.ChangeRequest{
		ID:                          glMR.ID,
		IID:                         glMR.IID,
		Title:                       glMR.Title,
		Description:                 glMR.Description,
		State:                       glMR.State,
		WebURL:                      glMR.WebURL,
		SourceBranch:                glMR.SourceBranch,
		TargetBranch:                glMR.TargetBranch,
		MergeStatus:                 glMR.MergeStatus,
		Draft:                       glMR.Draft,
		WorkInProgress:              glMR.WorkInProgress,
		HasConflicts:                glMR.HasConflicts,
		BlockingDiscussionsResolved: glMR.BlockingDiscussionsResolved,
		DetailedMergeStatus:         "checked",
		RebaseInProgress:            false,
		ApproveStatus:               nil,
	}
	result.Author.Name = glMR.Author.Name
	result.Author.Username = glMR.Author.Username

	if glMR.HeadPipeline != nil {
		result.HeadPipeline = &changerequest.PipelineRef{
			ID:     glMR.HeadPipeline.ID,
			Status: glMR.HeadPipeline.Status,
			WebURL: glMR.HeadPipeline.WebURL,
		}
	}

	return result
}

// glIssueLink represents a linked item (issue or MR) from GitLab's issue links API.
type glIssueLink struct {
	LinkType string `json:"link_type"` // "relates_to", "blocks", "is_blocked_by"
	Target   *struct {
		ID        int    `json:"id"`
		IID       int    `json:"iid"`
		Title     string `json:"title"`
		State     string `json:"state"`
		Type      string `json:"type"` // "issue" or "merge_request"
		WebURL    string `json:"web_url"`
		CreatedAt string `json:"created_at"`
		UpdatedAt string `json:"updated_at"`
		Author    struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"author"`
		Assignee *struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		} `json:"assignee"`
		Labels    []string `json:"labels"`
		Milestone *struct {
			Title string `json:"title"`
		} `json:"milestone"`
	} `json:"target"`
}

// fetchLinkedMRs calls the GitLab issue links API to find MRs linked to an issue
// via GitLab's UI linking feature (not just closing references).
func (ic *IssuesClient) fetchLinkedMRs(proj *ProjectInfo, issueIID int) ([]changerequest.ChangeRequest, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/issues/%d/links",
		ic.c.baseURL, projectPath, issueIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch issue links: %w", err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab API error fetching links (status %d): %s", statusCode, string(body))
	}

	var links []glIssueLink
	if err := json.Unmarshal(body, &links); err != nil {
		return nil, fmt.Errorf("failed to parse issue links: %w", err)
	}

	var results []changerequest.ChangeRequest
	for _, link := range links {
		if link.Target == nil || link.Target.Type != "merge_request" {
			continue
		}
		// Convert to changerequest.ChangeRequest — the link API returns basic info
		result := changerequest.ChangeRequest{
			ID:                          link.Target.ID,
			IID:                         link.Target.IID,
			Title:                       link.Target.Title,
			State:                       link.Target.State,
			WebURL:                      link.Target.WebURL,
			CreatedAt:                   parseTime(link.Target.CreatedAt),
			UpdatedAt:                   parseTime(link.Target.UpdatedAt),
			MergeStatus:                 "checked",
			DetailedMergeStatus:         "checked",
			BlockingDiscussionsResolved: true,
		}
		result.Author.Name = link.Target.Author.Name
		result.Author.Username = link.Target.Author.Username
		results = append(results, result)
	}

	return results, nil
}

// parseTime parses GitLab timestamp strings into time.Time.
// GitLab uses RFC3339 format. Returns zero time on parse failure.
func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// parseInlineMRReferences parses issue description for !{n} inline MR references.
// Returns deduplicated list of MR IIDs.
func parseInlineMRReferences(body string) []int {
	re := regexp.MustCompile(`!(\d+)`)
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

// fetchClosedByMRs calls the GitLab closed_by API endpoint for an issue.
func (ic *IssuesClient) fetchClosedByMRs(proj *ProjectInfo, issueIID int) ([]changerequest.ChangeRequest, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/issues/%d/closed_by",
		ic.c.baseURL, projectPath, issueIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch closed_by MRs: %w", err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab API error (status %d): %s", statusCode, string(body))
	}

	var glMRs []glClosedByMR
	if err := json.Unmarshal(body, &glMRs); err != nil {
		return nil, fmt.Errorf("failed to parse closed_by MRs: %w", err)
	}

	results := make([]changerequest.ChangeRequest, 0, len(glMRs))
	for _, glMR := range glMRs {
		results = append(results, convertGLClosedByMR(glMR))
	}

	return results, nil
}

// fetchMRByIID fetches a single MR by IID using the existing MR client infrastructure.
// We reuse the project's MR client via the underlying GitLab http client.
func (ic *IssuesClient) fetchMRByIID(proj *ProjectInfo, mrIID int) (*changerequest.ChangeRequest, error) {
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d",
		ic.c.baseURL, projectPath, mrIID)

	body, statusCode, err := ic.doGet(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch MR !%d: %w", mrIID, err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("GitLab API error fetching MR (status %d): %s", statusCode, string(body))
	}

	var glMR glClosedByMR
	if err := json.Unmarshal(body, &glMR); err != nil {
		return nil, fmt.Errorf("failed to parse MR response: %w", err)
	}

	result := convertGLClosedByMR(glMR)
	return &result, nil
}

// GetIssueLinkedChangeRequests implements issues.Client.GetIssueLinkedChangeRequests for GitLab.
// It calls the GitLab closed_by API endpoint for closing MRs and also parses
// the issue description for !{n} inline references, merging and deduplicating results.
func (ic *IssuesClient) GetIssueLinkedChangeRequests(info *issues.RepoInfo, number int) ([]changerequest.ChangeRequest, error) {
	proj := ic.project
	if info != nil && info.Namespace != "" && info.Project != "" {
		proj = &ProjectInfo{
			Host:      info.Host,
			Namespace: info.Namespace,
			Project:   info.Project,
		}
	}

	// 1. Fetch closed_by MRs
	closedByMRs, err := ic.fetchClosedByMRs(proj, number)
	if err != nil {
		log.Printf("[WARN] GitLab GetIssueLinkedChangeRequests: failed to fetch closed_by MRs for issue #%d: %v", number, err)
		closedByMRs = nil
	}

	// Track seen IIDs for deduplication
	seen := make(map[int]bool)
	for _, mr := range closedByMRs {
		seen[mr.IID] = true
	}

	// 1b. Also fetch issue links (catches draft MRs linked via GitLab UI)
	linkedMRs, err := ic.fetchLinkedMRs(proj, number)
	if err != nil {
		log.Printf("[WARN] GitLab GetIssueLinkedChangeRequests: failed to fetch linked MRs for issue #%d: %v", number, err)
	}
	for _, mr := range linkedMRs {
		if !seen[mr.IID] {
			seen[mr.IID] = true
			closedByMRs = append(closedByMRs, mr)
		}
	}

	// 2. Fetch the issue description and parse !{n} references
	issue, err := ic.GetIssue(info, number)
	if err != nil {
		log.Printf("[WARN] GitLab GetIssueLinkedChangeRequests: failed to fetch issue #%d for inline refs: %v", number, err)
		// Return closed_by results even if we can't get the issue body
		if closedByMRs == nil {
			return []changerequest.ChangeRequest{}, nil
		}
		return closedByMRs, nil
	}

	inlineRefs := parseInlineMRReferences(issue.Description)
	debugLog("GitLab GetIssueLinkedChangeRequests(#%d): %d closed_by MRs, %d inline refs", number, len(closedByMRs), len(inlineRefs))

	if len(inlineRefs) > 0 {
		for _, refIID := range inlineRefs {
			if seen[refIID] {
				continue
			}
			mrResult, err := ic.fetchMRByIID(proj, refIID)
			if err != nil {
				log.Printf("[WARN] GitLab GetIssueLinkedChangeRequests: failed to fetch inline MR !%d: %v", refIID, err)
				continue
			}
			seen[refIID] = true
			closedByMRs = append(closedByMRs, *mrResult)
		}
	}

	if closedByMRs == nil {
		return []changerequest.ChangeRequest{}, nil
	}

	return closedByMRs, nil
}
