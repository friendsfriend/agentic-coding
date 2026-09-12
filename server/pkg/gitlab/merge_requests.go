package gitlab

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

func (c *client) GetChangeRequests(projectInfo *ProjectInfo, sourceBranch, targetBranch string) ([]ChangeRequest, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests", c.baseURL, projectPath)

	// Add query parameters for filtering
	params := url.Values{}
	params.Set("state", "opened") // Only get open MRs
	if sourceBranch != "" {
		params.Set("source_branch", sourceBranch)
	}
	if targetBranch != "" {
		params.Set("target_branch", targetBranch)
	}
	params.Set("per_page", "100")                   // Get up to 100 MRs
	params.Set("with_merge_status_recheck", "true") // Ensure merge status is up to date

	apiURL += "?" + params.Encode()

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse JSON response
	var changeRequests []ChangeRequest
	if err := json.Unmarshal(body, &changeRequests); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	// For each MR, fetch the full details to get head_pipeline
	// This is necessary because the list endpoint doesn't always populate head_pipeline
	for i := range changeRequests {
		fullMR, err := c.GetChangeRequest(projectInfo, changeRequests[i].IID)
		if err == nil && fullMR != nil {
			changeRequests[i] = *fullMR
		}
		// If fetching full details fails, we still have basic MR info
	}

	return changeRequests, nil
}

// GetChangeRequestsWithOptions fetches change requests with pagination and filter options.
func normalizeGitLabMRSort(sortBy string) string {
	switch sortBy {
	case "created", "created_at":
		return "created_at"
	case "updated", "updated_at":
		return "updated_at"
	case "title":
		return "title"
	default:
		return "updated_at"
	}
}

func (c *client) GetChangeRequestsWithOptions(projectInfo *ProjectInfo, opts *changerequest.ChangeRequestListOptions) (*changerequest.ChangeRequestListResult, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests", c.baseURL, projectPath)

	params := url.Values{}

	state := "opened"
	page := 1
	perPage := 50
	if opts != nil {
		if opts.State != "" {
			state = opts.State
		}
		if opts.Page > 0 {
			page = opts.Page
		}
		if opts.PerPage > 0 {
			perPage = opts.PerPage
		}
		if opts.SourceBranch != "" {
			params.Set("source_branch", opts.SourceBranch)
		}
		if opts.TargetBranch != "" {
			params.Set("target_branch", opts.TargetBranch)
		}
		if opts.Search != "" {
			params.Set("search", opts.Search)
		}
		if len(opts.Labels) > 0 {
			params.Set("labels", strings.Join(opts.Labels, ","))
		}
		if opts.SortBy != "" {
			params.Set("order_by", normalizeGitLabMRSort(opts.SortBy))
		}
		if opts.SortDirection == "asc" || opts.SortDirection == "desc" {
			params.Set("sort", opts.SortDirection)
		}
	}

	if params.Get("order_by") == "" {
		params.Set("order_by", "updated_at")
	}
	if params.Get("sort") == "" {
		params.Set("sort", "desc")
	}

	params.Set("state", state)
	params.Set("page", fmt.Sprintf("%d", page))
	params.Set("per_page", fmt.Sprintf("%d", perPage))
	params.Set("with_merge_status_recheck", "true")

	apiURL += "?" + params.Encode()

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

	// Parse pagination headers
	totalCount := -1
	totalPages := -1
	currentPage := page

	if totalStr := resp.Header.Get("X-Total"); totalStr != "" {
		if t, err := strconv.Atoi(totalStr); err == nil {
			totalCount = t
		}
	}
	if totalPagesStr := resp.Header.Get("X-Total-Pages"); totalPagesStr != "" {
		if tp, err := strconv.Atoi(totalPagesStr); err == nil {
			totalPages = tp
		}
	}
	if pageStr := resp.Header.Get("X-Page"); pageStr != "" {
		if p, err := strconv.Atoi(pageStr); err == nil {
			currentPage = p
		}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var changeRequests []ChangeRequest
	if err := json.Unmarshal(body, &changeRequests); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	// SkipDetails mode: when true, skip per-MR detail and approval fetches
	skipDetails := opts != nil && opts.SkipDetails

	if !skipDetails {
		// For each MR, fetch full details to get head_pipeline.
		// GetChangeRequest already fetches approval info internally.
		for i := range changeRequests {
			fullMR, err := c.GetChangeRequest(projectInfo, changeRequests[i].IID)
			if err == nil && fullMR != nil {
				changeRequests[i] = *fullMR
			}
		}
	}

	return &changerequest.ChangeRequestListResult{
		ChangeRequests: convertMRsToChangeRequest(changeRequests),
		TotalCount:     totalCount,
		TotalPages:     totalPages,
		CurrentPage:    currentPage,
		PerPage:        perPage,
	}, nil
}

// GetChangeRequest fetches a single change request by IID with full details including pipeline
func (c *client) GetChangeRequest(projectInfo *ProjectInfo, mrIID int) (*ChangeRequest, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for single MR
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d", c.baseURL, projectPath, mrIID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitLab API request failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse JSON response
	var mergeRequest ChangeRequest
	if err := json.Unmarshal(body, &mergeRequest); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	// Fetch approval information separately
	approvals, err := c.GetMergeRequestApprovals(projectInfo, mrIID)
	if err == nil && approvals != nil {
		mergeRequest.Approvals = approvals
	}
	// If fetching approvals fails, we still return the MR without approval info

	return &mergeRequest, nil
}

// GetMergeRequestApprovals fetches approval information for a change request
func (c *client) GetMergeRequestApprovals(projectInfo *ProjectInfo, mrIID int) (*MergeRequestApprovals, error) {
	if projectInfo == nil {
		return nil, fmt.Errorf("project info is nil")
	}

	// URL encode the project path (namespace/project)
	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", projectInfo.Namespace, projectInfo.Project))

	// Construct API URL for MR approvals
	apiURL := fmt.Sprintf("%s/api/v4/projects/%s/merge_requests/%d/approvals", c.baseURL, projectPath, mrIID)

	// Create request
	req, err := http.NewRequestWithContext(c.requestContext(), "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add authentication header
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("User-Agent", "devenv-cli")
	req.Header.Set("Accept", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		// Approvals API might not be available for all GitLab instances (e.g., CE vs EE)
		// Return nil without error so we can continue without approval info
		return nil, fmt.Errorf("approvals endpoint returned status %d", resp.StatusCode)
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse JSON response
	var approvals MergeRequestApprovals
	if err := json.Unmarshal(body, &approvals); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	return &approvals, nil
}
