package github

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// --- Conversion helpers ---

func prStateToChangeRequestState(pr ghPR) string {
	if pr.Merged {
		return "merged"
	}
	if pr.State == "closed" {
		return "closed"
	}
	return "opened"
}

func mergeableToChangeRequestStatus(pr ghPR) (mergeStatus, detailedMergeStatus string, hasConflicts bool) {
	if pr.Mergeable == nil {
		// GitHub hasn't computed it yet
		return "checking", "checking", false
	}
	if *pr.Mergeable {
		return "can_be_merged", pr.MergeableState, false
	}
	// Not mergeable — treat "dirty" as conflicts
	if pr.MergeableState == "dirty" {
		return "cannot_be_merged", pr.MergeableState, true
	}
	return "cannot_be_merged", pr.MergeableState, false
}

func defaultBranchFromPR(pr ghPR) string {
	if pr.Base.Repo != nil {
		return pr.Base.Repo.DefaultBranch
	}
	return ""
}

func convertPR(pr ghPR, approvals *MergeRequestApprovals, latestRun *ghWorkflowRun) ChangeRequest {
	mergeStatus, detailedMergeStatus, hasConflicts := mergeableToChangeRequestStatus(pr)
	state := prStateToChangeRequestState(pr)

	mr := ChangeRequest{
		ID:                          pr.ID,
		IID:                         pr.Number,
		Title:                       pr.Title,
		Description:                 pr.Body,
		SourceBranch:                pr.Head.Ref,
		TargetBranch:                pr.Base.Ref,
		DefaultBranch:               defaultBranchFromPR(pr),
		State:                       state,
		WebURL:                      pr.HTMLURL,
		CreatedAt:                   pr.CreatedAt,
		UpdatedAt:                   pr.UpdatedAt,
		MergeStatus:                 mergeStatus,
		DetailedMergeStatus:         detailedMergeStatus,
		Draft:                       pr.Draft,
		WorkInProgress:              pr.Draft,
		HasConflicts:                hasConflicts,
		BlockingDiscussionsResolved: true,
		RebaseInProgress:            false,
		Approvals:                   approvals,
	}
	mr.Author.Name = pr.User.Login
	mr.Author.Username = pr.User.Login

	if latestRun != nil {
		mr.HeadPipeline = &struct {
			ID     int    `json:"id"`
			Status string `json:"status"`
			WebURL string `json:"web_url"`
		}{
			ID:     latestRun.ID,
			Status: mapRunStatusToGitLab(*latestRun),
			WebURL: latestRun.HTMLURL,
		}
	}

	return mr
}

// convertPRToChangeRequest converts a GitHub PR to the unified changerequest.ChangeRequest format.
func convertPRToChangeRequest(pr ghPR, approvals *MergeRequestApprovals, latestRun *ghWorkflowRun) changerequest.ChangeRequest {
	mergeStatus, detailedMergeStatus, hasConflicts := mergeableToChangeRequestStatus(pr)
	state := prStateToChangeRequestState(pr)

	result := changerequest.ChangeRequest{
		ID:                          pr.ID,
		IID:                         pr.Number,
		Title:                       pr.Title,
		Description:                 pr.Body,
		SourceBranch:                pr.Head.Ref,
		TargetBranch:                pr.Base.Ref,
		DefaultBranch:               defaultBranchFromPR(pr),
		State:                       state,
		WebURL:                      pr.HTMLURL,
		CreatedAt:                   pr.CreatedAt,
		UpdatedAt:                   pr.UpdatedAt,
		MergeStatus:                 mergeStatus,
		DetailedMergeStatus:         detailedMergeStatus,
		Draft:                       pr.Draft,
		WorkInProgress:              pr.Draft,
		HasConflicts:                hasConflicts,
		BlockingDiscussionsResolved: true,
		RebaseInProgress:            false,
	}
	if approvals != nil {
		result.ApproveStatus = &changerequest.ApproveStatus{
			ApprovalsRequired: approvals.ApprovalsRequired,
			ApprovalsLeft:     approvals.ApprovalsLeft,
			ApprovedBy:        approvals.ApprovedBy,
		}
	}
	result.Author.Name = pr.User.Login
	result.Author.Username = pr.User.Login

	if latestRun != nil {
		result.HeadPipeline = &changerequest.PipelineRef{
			ID:     latestRun.ID,
			Status: mapRunStatusToGitLab(*latestRun),
			WebURL: latestRun.HTMLURL,
		}
	}

	return result
}

// GetChangeRequests implements changerequest.Client.GetChangeRequests.
func normalizeGithubPRSort(sortBy string) string {
	switch sortBy {
	case "created", "updated", "popularity", "long-running":
		return sortBy
	default:
		return "updated"
	}
}

func (c *client) GetChangeRequests(info *changerequest.RepoInfo, options *changerequest.ChangeRequestListOptions) (*changerequest.ChangeRequestListResult, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	page := 1
	perPage := 50
	sourceBranch := ""
	targetBranch := ""
	search := ""
	state := "open"
	sortBy := "updated"
	order := "desc"
	labels := []string(nil)
	if options != nil {
		if options.Page > 0 {
			page = options.Page
		}
		if options.PerPage > 0 {
			perPage = options.PerPage
		}
		sourceBranch = options.SourceBranch
		targetBranch = options.TargetBranch
		search = options.Search
		labels = options.Labels
		if options.State != "" {
			state = options.State
		}
		if options.SortBy != "" {
			sortBy = options.SortBy
		}
		if options.SortDirection == "asc" || options.SortDirection == "desc" {
			order = options.SortDirection
		}
	}

	skipDetails := options != nil && options.SkipDetails

	// When search is provided, use the GitHub search/issues endpoint
	// since the pulls list endpoint doesn't support search.
	if search != "" || len(labels) > 0 {
		return c.searchPullRequests(ghInfo, search, page, perPage, state, skipDetails, sortBy, order, labels)
	}

	// GitHub API doesn't have a native "merged" state. Merged PRs have state=closed + merged=true.
	// Map our state values to GitHub API values:
	//   "opened" → "open"
	//   "closed" → "closed" (GitHub returns all closed PRs — merged ones are filtered in prStateToChangeRequestState)
	//   "all"    → "all"
	apiState := state
	switch state {
	case "closed":
		apiState = "closed"
	case "opened":
		apiState = "open"
	default:
		apiState = state
	}

	params := url.Values{}
	params.Set("state", apiState)
	params.Set("per_page", fmt.Sprintf("%d", perPage))
	params.Set("page", fmt.Sprintf("%d", page))
	params.Set("sort", normalizeGithubPRSort(sortBy))
	params.Set("direction", order)
	if sourceBranch != "" {
		params.Set("head", fmt.Sprintf("%s:%s", ghInfo.Owner, sourceBranch))
	}
	if targetBranch != "" {
		params.Set("base", targetBranch)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls?%s",
		ghInfo.Owner, ghInfo.Repo, params.Encode())

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

	// Parse pagination from Link header
	linkHeader := resp.Header.Get("Link")
	currentPage, totalPages := parseLinkHeaderForPagination(linkHeader, page)

	var prs []ghPR
	if err := json.Unmarshal(body, &prs); err != nil {
		return nil, fmt.Errorf("failed to parse pull requests: %w", err)
	}

	results := make([]changerequest.ChangeRequest, 0, len(prs))
	for _, pr := range prs {
		var approvals *MergeRequestApprovals
		var latestRun *ghWorkflowRun

		if !skipDetails {
			var err error
			approvals, err = c.GetPRApprovals(ghInfo, pr.Number)
			if err != nil {
				log.Printf("[WARN] Failed to fetch approvals for PR #%d: %v", pr.Number, err)
			}
			latestRun, err = c.GetLatestRunForSHA(ghInfo, pr.Head.SHA)
			if err != nil {
				log.Printf("[WARN] Failed to fetch workflow run for PR #%d (SHA %s): %v", pr.Number, pr.Head.SHA, err)
			}
		}

		mrResult := convertPRToChangeRequest(pr, approvals, latestRun)
		results = append(results, mrResult)
	}

	return &changerequest.ChangeRequestListResult{
		ChangeRequests: results,
		TotalCount:     -1,
		TotalPages:     totalPages,
		CurrentPage:    currentPage,
		PerPage:        perPage,
	}, nil
}

// searchPullRequests searches pull requests via GitHub's /search/issues endpoint.
// GitHub's REST API treats PRs as a type of issue; the qualifier "type:pr"
// in the search query filters out regular issues, returning PRs only.
// This is the documented GitHub API approach — the pulls list endpoint
// (/repos/{owner}/{repo}/pulls) does not support free-text search.
func (c *client) searchPullRequests(ghInfo *RepoInfo, query string, page, perPage int, state string, skipDetails bool, sortBy, order string, labels []string) (*changerequest.ChangeRequestListResult, error) {
	// Build search query with state qualifier.
	// GitHub search API values: state:open, state:closed, state:all
	labelQuery := ""
	for _, label := range labels {
		labelQuery += fmt.Sprintf(" label:%q", label)
	}
	searchQuery := strings.TrimSpace(fmt.Sprintf("repo:%s/%s type:pr state:%s %s %s", ghInfo.Owner, ghInfo.Repo, state, query, labelQuery))

	params := url.Values{}
	params.Set("q", searchQuery)
	params.Set("per_page", fmt.Sprintf("%d", perPage))
	params.Set("page", fmt.Sprintf("%d", page))
	params.Set("sort", normalizeGithubIssueSort(sortBy))
	params.Set("order", order)

	apiURL := fmt.Sprintf("https://api.github.com/search/issues?%s", params.Encode())

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to execute search request: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub search API error (status %d): %s", resp.StatusCode, string(body))
	}

	var searchResp struct {
		TotalCount int `json:"total_count"`
		Items      []struct {
			Number    int       `json:"number"`
			Title     string    `json:"title"`
			Body      string    `json:"body"`
			State     string    `json:"state"`
			HTMLURL   string    `json:"html_url"`
			CreatedAt time.Time `json:"created_at"`
			UpdatedAt time.Time `json:"updated_at"`
			User      struct {
				Login string `json:"login"`
			} `json:"user"`
		} `json:"items"`
	}

	if err := json.Unmarshal(body, &searchResp); err != nil {
		return nil, fmt.Errorf("failed to parse search results: %w", err)
	}

	// Parse pagination from Link header
	linkHeader := resp.Header.Get("Link")
	_, totalPages := parseLinkHeaderForPagination(linkHeader, page)

	results := make([]changerequest.ChangeRequest, 0, len(searchResp.Items))
	for _, item := range searchResp.Items {
		// If not SkipDetails, fetch full PR details which includes all fields
		if !skipDetails {
			fullPR, err := c.GetPullRequest(ghInfo, item.Number)
			if err == nil && fullPR != nil {
				mrResult := convertPRToChangeRequest(ghPR{
					Number:    fullPR.IID,
					Title:     fullPR.Title,
					Body:      fullPR.Description,
					State:     fullPR.State,
					HTMLURL:   fullPR.WebURL,
					CreatedAt: fullPR.CreatedAt,
					UpdatedAt: fullPR.UpdatedAt,
					User:      ghUser{Login: fullPR.Author.Username},
					Head:      ghPRBranch{Ref: fullPR.SourceBranch},
					Base:      ghPRBranch{Ref: fullPR.TargetBranch},
				}, fullPR.Approvals, nil)
				// Copy pipeline from fullPR if available
				if fullPR.HeadPipeline != nil {
					mrResult.HeadPipeline = &changerequest.PipelineRef{
						ID:     fullPR.HeadPipeline.ID,
						Status: fullPR.HeadPipeline.Status,
						WebURL: fullPR.HeadPipeline.WebURL,
					}
				}
				results = append(results, mrResult)
				continue
			}
		}

		// Fallback: build minimal MR from search result
		mrResult := changerequest.ChangeRequest{
			IID:                         item.Number,
			Title:                       item.Title,
			Description:                 item.Body,
			WebURL:                      item.HTMLURL,
			CreatedAt:                   item.CreatedAt,
			UpdatedAt:                   item.UpdatedAt,
			BlockingDiscussionsResolved: true,
		}
		mrResult.Author.Name = item.User.Login
		mrResult.Author.Username = item.User.Login
		mrResult.State = "opened"
		if item.State == "closed" {
			mrResult.State = "closed"
		}

		results = append(results, mrResult)
	}

	// Calculate total pages from total count
	totalPages = (searchResp.TotalCount + perPage - 1) / perPage

	return &changerequest.ChangeRequestListResult{
		ChangeRequests: results,
		TotalCount:     searchResp.TotalCount,
		TotalPages:     totalPages,
		CurrentPage:    page,
		PerPage:        perPage,
	}, nil
}

// GetPullRequest fetches a single pull request by number with full details.
func (c *client) GetPullRequest(info *RepoInfo, prNumber int) (*ChangeRequest, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d",
		info.Owner, info.Repo, prNumber)

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

	var pr ghPR
	if err := json.Unmarshal(body, &pr); err != nil {
		return nil, fmt.Errorf("failed to parse pull request: %w", err)
	}

	approvals, err := c.GetPRApprovals(info, prNumber)
	if err != nil {
		log.Printf("[WARN] Failed to fetch approvals for PR #%d: %v", prNumber, err)
	}

	latestRun, err := c.GetLatestRunForSHA(info, pr.Head.SHA)
	if err != nil {
		log.Printf("[WARN] Failed to fetch workflow run for PR #%d (SHA %s): %v", prNumber, pr.Head.SHA, err)
	}

	mr := convertPR(pr, approvals, latestRun)
	return &mr, nil
}
