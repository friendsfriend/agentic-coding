package github

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/friendsfriend/devenv/pkg/issues"
)

// --- GitHub API raw types for issues ---

type ghLabel struct {
	Name string `json:"name"`
}

type ghMilestone struct {
	Title string `json:"title"`
}

type ghAssignee struct {
	Login string `json:"login"`
}

type ghIssue struct {
	ID          int          `json:"id"`
	Number      int          `json:"number"`
	Title       string       `json:"title"`
	Body        string       `json:"body"`
	State       string       `json:"state"`
	HTMLURL     string       `json:"html_url"`
	User        ghUser       `json:"user"`
	Labels      []ghLabel    `json:"labels"`
	Assignees   []ghAssignee `json:"assignees"`
	Milestone   *ghMilestone `json:"milestone,omitempty"`
	PullRequest *struct{}    `json:"pull_request,omitempty"` // non-nil means this is a PR
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

// ghIssueComment is defined in client.go — using that type here

// timelineEventToComment converts a timeline event to an IssueComment with system=true.
func timelineEventToComment(e *ghTimelineEvent) issues.IssueComment {
	var body string
	switch e.Event {
	case "labeled":
		if e.Label != nil {
			body = fmt.Sprintf("added ~%s label", e.Label.Name)
		} else {
			body = "added label"
		}
	case "unlabeled":
		if e.Label != nil {
			body = fmt.Sprintf("removed ~%s label", e.Label.Name)
		} else {
			body = "removed label"
		}
	case "assigned":
		if e.Assignee != nil {
			body = fmt.Sprintf("assigned to @%s", e.Assignee.Login)
		} else {
			body = "assigned"
		}
	case "unassigned":
		if e.Assignee != nil {
			body = fmt.Sprintf("unassigned @%s", e.Assignee.Login)
		} else {
			body = "unassigned"
		}
	case "milestoned":
		if e.Milestone != nil {
			body = fmt.Sprintf("added to milestone **%s**", e.Milestone.Title)
		} else {
			body = "added to milestone"
		}
	case "demilestoned":
		if e.Milestone != nil {
			body = fmt.Sprintf("removed from milestone **%s**", e.Milestone.Title)
		} else {
			body = "removed from milestone"
		}
	case "renamed":
		if e.Rename != nil {
			body = fmt.Sprintf("changed title from **%s** to **%s**", e.Rename.From, e.Rename.To)
		} else {
			body = "changed title"
		}
	case "locked":
		body = "locked the conversation"
	case "unlocked":
		body = "unlocked the conversation"
	case "closed":
		body = "closed"
	case "reopened":
		body = "reopened"
	case "cross-referenced":
		if e.Source != nil && e.Source.Issue != nil {
			body = fmt.Sprintf("mentioned in #%d %s", e.Source.Issue.Number, e.Source.Issue.Title)
		} else {
			body = "mentioned in another issue"
		}
	case "review_requested":
		if e.RequestedReviewer != nil {
			body = fmt.Sprintf("requested review from @%s", e.RequestedReviewer.Login)
		} else {
			body = "requested review"
		}
	case "review_request_removed":
		if e.RequestedReviewer != nil {
			body = fmt.Sprintf("removed review request from @%s", e.RequestedReviewer.Login)
		} else {
			body = "removed review request"
		}
	case "ready_for_review":
		body = "marked as ready for review"
	case "head_ref_deleted":
		body = "deleted the head branch"
	case "head_ref_restored":
		body = "restored the head branch"
	case "base_ref_changed":
		body = "changed the base branch"
	case "committed":
		body = "added a commit"
	case "subscribed":
		body = "subscribed"
	case "unsubscribed":
		body = "unsubscribed"
	case "pinned":
		body = "pinned"
	case "unpinned":
		body = "unpinned"
	case "marked_as_duplicate":
		body = "marked as duplicate"
	case "unmarked_as_duplicate":
		body = "unmarked as duplicate"
	default:
		body = e.Event
	}
	authorName := e.Actor.Login
	if authorName == "" {
		authorName = "unknown"
	}
	return issues.IssueComment{
		ID:   e.ID,
		Body: body,
		Author: struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		}{
			Name:     authorName,
			Username: authorName,
		},
		CreatedAt: e.CreatedAt,
		UpdatedAt: e.CreatedAt,
		System:    true,
	}
}

// GetIssueComments returns both regular comments AND timeline events for GitHub issues.
// GitHub's issue comments endpoint only returns user comments; timeline events
// (label changes, assignments, etc.) are fetched from the Timeline API separately
// and merged in as system notes — matching GitLab's behavior where system notes
// are included in the comments response.
func (ic *IssuesClient) GetIssueComments(info *issues.RepoInfo, number int) (*issues.IssueCommentListResult, error) {
	ghInfo := ic.info
	if info != nil {
		if info.Owner != "" && info.Repo != "" {
			ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
		}
	}

	// Fetch regular comments
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/comments?per_page=100",
		ghInfo.Owner, ghInfo.Repo, number)

	resp, err := ic.c.doRequest("GET", apiURL, nil)
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

	var ghComments []ghIssueComment
	if err := json.Unmarshal(body, &ghComments); err != nil {
		return nil, fmt.Errorf("failed to parse issue comments: %w", err)
	}

	// Build results from regular comments (system=false)
	results := make([]issues.IssueComment, 0, len(ghComments))
	for _, c := range ghComments {
		results = append(results, convertGHIssueComment(c))
	}

	// Also fetch timeline events (label changes, assignments, etc.)
	// GitHub's timeline API returns both comments AND events.
	// We only process events here (comments are already handled above).
	timeline := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/timeline?per_page=100",
		ghInfo.Owner, ghInfo.Repo, number)
	tlResp, tlErr := ic.c.doRequest("GET", timeline, nil)
	if tlErr == nil && tlResp.StatusCode == http.StatusOK {
		tlBody, _ := readBody(tlResp)
		var events []ghTimelineEvent
		if json.Unmarshal(tlBody, &events) == nil {
			for i := range events {
				e := &events[i]
				// Skip "commented" events — those are regular comments already fetched
				if e.Event == "commented" {
					continue
				}
				// Skip non-event types that have no event label
				if e.Event == "" {
					continue
				}
				results = append(results, timelineEventToComment(e))
			}
		}
	}

	linkHeader := resp.Header.Get("Link")
	_, totalPages := parseLinkHeaderForPagination(linkHeader, 1)

	return &issues.IssueCommentListResult{
		Comments:    results,
		TotalCount:  -1,
		TotalPages:  totalPages,
		CurrentPage: 1,
		PerPage:     100,
	}, nil
}

func convertGHIssue(issue ghIssue) issues.Issue {
	result := issues.Issue{
		ID:          issue.ID,
		IID:         issue.Number,
		Title:       issue.Title,
		Description: issue.Body,
		State:       issue.State,
		WebURL:      issue.HTMLURL,
		CreatedAt:   issue.CreatedAt,
		UpdatedAt:   issue.UpdatedAt,
	}
	result.Author.Name = issue.User.Login
	result.Author.Username = issue.User.Login

	for _, l := range issue.Labels {
		result.Labels = append(result.Labels, l.Name)
	}
	for _, a := range issue.Assignees {
		result.Assignees = append(result.Assignees, struct {
			Name     string `json:"name"`
			Username string `json:"username"`
		}{Name: a.Login, Username: a.Login})
	}
	if issue.Milestone != nil {
		result.Milestone = &struct {
			Title string `json:"title"`
		}{Title: issue.Milestone.Title}
	}

	return result
}

func convertGHIssueComment(comment ghIssueComment) issues.IssueComment {
	result := issues.IssueComment{
		ID:        comment.ID,
		Body:      comment.Body,
		CreatedAt: comment.CreatedAt,
		UpdatedAt: comment.UpdatedAt,
		System:    false,
	}
	result.Author.Name = comment.User.Login
	result.Author.Username = comment.User.Login
	return result
}

// --- issues.Client implementation ---

// IssuesClient wraps a GitHub client to implement issues.Client.
type IssuesClient struct {
	c    *client
	info *RepoInfo
}

// NewIssuesClient creates a new IssuesClient for the given repository.
func NewIssuesClient(c Client, info *RepoInfo) issues.Client {
	// Access the underlying *client
	ghClient := c.(*client)
	return &IssuesClient{
		c:    ghClient,
		info: info,
	}
}

// GetIssues implements issues.Client.GetIssues.
func normalizeGithubIssueSort(sortBy string) string {
	switch sortBy {
	case "created", "updated", "comments":
		return sortBy
	default:
		return "updated"
	}
}

func (ic *IssuesClient) GetIssues(info *issues.RepoInfo, options *issues.IssueListOptions) (*issues.IssueListResult, error) {
	ghInfo := ic.info
	if info != nil {
		if info.Owner != "" && info.Repo != "" {
			ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
		}
	}

	page := 1
	perPage := 50
	scope := ""
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
		scope = options.Scope
		search = options.Search
		if options.State != "" {
			state = options.State
		}
		if options.SortBy != "" {
			sortBy = options.SortBy
		}
		if options.SortDirection == "asc" || options.SortDirection == "desc" {
			order = options.SortDirection
		}
		labels = options.Labels
	}

	// GitHub search API only supports `state:open` and `state:closed` qualifiers.
	// `state:all` is not valid and would return 0 results.
	// For "all", use the list endpoint which supports `state=all` natively,
	// then filter out PRs from the response.
	if state == "all" {
		return ic.listAllIssues(ghInfo, scope, search, page, perPage, sortBy, order, labels)
	}

	// Build search query: combine explicit search with scope filter.
	// We use the search API for scope filtering because GitHub's `filter`
	// parameter doesn't work with fine-grained PATs. The search API
	// supports assignee:@me, author:@me, no:assignee reliably.
	searchQueryParts := search
	scopeQuery := ""
	switch scope {
	case "assigned-to-me":
		scopeQuery = "assignee:@me"
	case "created-by-me":
		scopeQuery = "author:@me"
	case "no-assignee":
		scopeQuery = "no:assignee"
	}
	if scopeQuery != "" {
		if searchQueryParts != "" {
			searchQueryParts = searchQueryParts + " " + scopeQuery
		} else {
			searchQueryParts = scopeQuery
		}
	}
	// Always use the search API so GitHub paginates over real issues only.
	// The standard /issues endpoint includes pull requests, and filtering PRs
	// after pagination makes pages contain a variable number of issues.
	return ic.searchIssues(ghInfo, searchQueryParts, page, perPage, state, sortBy, order, labels)
}

// searchIssues searches issues via GitHub's /search/issues endpoint.
func (ic *IssuesClient) searchIssues(ghInfo *RepoInfo, query string, page, perPage int, state, sortBy, order string, labels []string) (*issues.IssueListResult, error) {
	labelQuery := ""
	for _, label := range labels {
		labelQuery += fmt.Sprintf(" label:%q", label)
	}
	searchQuery := strings.TrimSpace(fmt.Sprintf("repo:%s/%s type:issue state:%s %s %s", ghInfo.Owner, ghInfo.Repo, state, query, labelQuery))

	params := url.Values{}
	params.Set("q", searchQuery)
	params.Set("per_page", fmt.Sprintf("%d", perPage))
	params.Set("page", fmt.Sprintf("%d", page))
	params.Set("sort", normalizeGithubIssueSort(sortBy))
	params.Set("order", order)

	apiURL := fmt.Sprintf("https://api.github.com/search/issues?%s", params.Encode())

	resp, err := ic.c.doRequest("GET", apiURL, nil)
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
		TotalCount int       `json:"total_count"`
		Items      []ghIssue `json:"items"`
	}

	if err := json.Unmarshal(body, &searchResp); err != nil {
		return nil, fmt.Errorf("failed to parse search results: %w", err)
	}

	// Parse pagination
	linkHeader := resp.Header.Get("Link")
	_, totalPages := parseLinkHeaderForPagination(linkHeader, page)
	totalPages = (searchResp.TotalCount + perPage - 1) / perPage

	results := make([]issues.Issue, 0, len(searchResp.Items))
	for _, item := range searchResp.Items {
		if item.PullRequest != nil {
			continue
		}
		results = append(results, convertGHIssue(item))
	}

	return &issues.IssueListResult{
		Issues:      results,
		TotalCount:  searchResp.TotalCount,
		TotalPages:  totalPages,
		CurrentPage: page,
		PerPage:     perPage,
	}, nil
}

// listAllIssues uses the list endpoint (not search) to fetch issues in ALL states.
// GitHub's search API doesn't support `state:all`, so we fall back to the list endpoint
// which supports `state=all` natively. PRs are filtered out post-fetch.
func (ic *IssuesClient) listAllIssues(ghInfo *RepoInfo, scope, search string, page, perPage int, sortBy, order string, labels []string) (*issues.IssueListResult, error) {
	params := url.Values{}
	params.Set("state", "all")
	params.Set("page", fmt.Sprintf("%d", page))
	params.Set("per_page", fmt.Sprintf("%d", perPage))
	params.Set("sort", normalizeGithubIssueSort(sortBy))
	params.Set("direction", order)

	// Map scope to GitHub's filter parameter when available
	// Note: `filter` doesn't work with fine-grained PATs, but for "all" state we
	// use the list endpoint anyway. Scope-based filtering is best-effort here.
	switch scope {
	case "assigned-to-me":
		params.Set("filter", "assigned")
	case "created-by-me":
		params.Set("filter", "created")
	case "no-assignee":
		// No direct filter for unassigned — we skip scope filtering
	}

	if len(labels) > 0 {
		params.Set("labels", strings.Join(labels, ","))
	}
	if search != "" {
		// The list endpoint doesn't support free-text search, but it does support
		// basic issue number search via the issue number itself.
		// For actual text search, users should use the search API with state:open or state:closed.
		params.Set("q", search)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues?%s",
		ghInfo.Owner, ghInfo.Repo, params.Encode())

	resp, err := ic.c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to list issues: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error listing issues (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse pagination headers
	linkHeader := resp.Header.Get("Link")
	currentPage, totalPages := parseLinkHeaderForPagination(linkHeader, page)

	var items []struct {
		ghIssue
		PullRequest *json.RawMessage `json:"pull_request,omitempty"`
	}
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("failed to parse issues: %w", err)
	}

	results := make([]issues.Issue, 0, len(items))
	for _, item := range items {
		if item.PullRequest != nil {
			continue
		}
		results = append(results, convertGHIssue(item.ghIssue))
	}

	return &issues.IssueListResult{
		Issues:      results,
		TotalCount:  -1,
		TotalPages:  totalPages,
		CurrentPage: currentPage,
		PerPage:     perPage,
	}, nil
}

// GetIssue implements issues.Client.GetIssue.
func (ic *IssuesClient) GetIssue(info *issues.RepoInfo, number int) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil {
		if info.Owner != "" && info.Repo != "" {
			ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
		}
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d",
		ghInfo.Owner, ghInfo.Repo, number)

	resp, err := ic.c.doRequest("GET", apiURL, nil)
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

	var ghIss ghIssue
	if err := json.Unmarshal(body, &ghIss); err != nil {
		return nil, fmt.Errorf("failed to parse issue: %w", err)
	}

	result := convertGHIssue(ghIss)
	return &result, nil
}

// GetIssueComments implements issues.Client.GetIssueComments.

// --- Mutation implementations ---

// CloseIssue implements issues.Client.CloseIssue for GitHub.
func (ic *IssuesClient) CloseIssue(info *issues.RepoInfo, number int, reason string) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	type closePayload struct {
		State       string `json:"state"`
		StateReason string `json:"state_reason,omitempty"`
	}
	payload := closePayload{State: "closed", StateReason: reason}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d", ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("PATCH", apiURL, strings.NewReader(string(jsonPayload)))
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

	var ghIss ghIssue
	if err := json.Unmarshal(body, &ghIss); err != nil {
		return nil, fmt.Errorf("failed to parse closed issue: %w", err)
	}

	result := convertGHIssue(ghIss)
	return &result, nil
}

// ReopenIssue implements issues.Client.ReopenIssue for GitHub.
func (ic *IssuesClient) ReopenIssue(info *issues.RepoInfo, number int) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	payload := map[string]string{"state": "open"}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d", ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("PATCH", apiURL, strings.NewReader(string(jsonPayload)))
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

	var ghIss ghIssue
	if err := json.Unmarshal(body, &ghIss); err != nil {
		return nil, fmt.Errorf("failed to parse reopened issue: %w", err)
	}

	result := convertGHIssue(ghIss)
	return &result, nil
}

// SetLabels implements issues.Client.SetLabels for GitHub.
func (ic *IssuesClient) SetLabels(info *issues.RepoInfo, number int, labels []string) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	type labelsPayload struct {
		Labels []string `json:"labels"`
	}

	payload := labelsPayload{Labels: labels}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal labels payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/labels", ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("PUT", apiURL, strings.NewReader(string(jsonPayload)))
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

	// Re-fetch the issue to get updated state
	return ic.GetIssue(info, number)
}

// AddAssignee implements issues.Client.AddAssignee for GitHub.
func (ic *IssuesClient) AddAssignee(info *issues.RepoInfo, number int, assignee string) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	type assigneePayload struct {
		Assignees []string `json:"assignees"`
	}

	payload := assigneePayload{Assignees: []string{assignee}}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal assignee payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/assignees", ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("POST", apiURL, strings.NewReader(string(jsonPayload)))
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

	return ic.GetIssue(info, number)
}

// RemoveAssignee implements issues.Client.RemoveAssignee for GitHub.
func (ic *IssuesClient) RemoveAssignee(info *issues.RepoInfo, number int) (*issues.Issue, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	type assigneePayload struct {
		Assignees []string `json:"assignees"`
	}

	payload := assigneePayload{Assignees: []string{}}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal remove assignee payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/assignees", ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("DELETE", apiURL, strings.NewReader(string(jsonPayload)))
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

	return ic.GetIssue(info, number)
}

// GetRepoLabels implements issues.Client.GetRepoLabels for GitHub.
func (ic *IssuesClient) GetRepoLabels(info *issues.RepoInfo) ([]string, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/labels?per_page=100", ghInfo.Owner, ghInfo.Repo)
	resp, err := ic.c.doRequest("GET", apiURL, nil)
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

	var ghLabels []ghLabel
	if err := json.Unmarshal(body, &ghLabels); err != nil {
		return nil, fmt.Errorf("failed to parse labels: %w", err)
	}

	result := make([]string, 0, len(ghLabels))
	for _, l := range ghLabels {
		result = append(result, l.Name)
	}
	return result, nil
}

// GetRepoCollaborators implements issues.Client.GetRepoCollaborators for GitHub.
func (ic *IssuesClient) GetRepoCollaborators(info *issues.RepoInfo) ([]string, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/collaborators?per_page=100", ghInfo.Owner, ghInfo.Repo)
	resp, err := ic.c.doRequest("GET", apiURL, nil)
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

	var users []ghUser
	if err := json.Unmarshal(body, &users); err != nil {
		return nil, fmt.Errorf("failed to parse collaborators: %w", err)
	}

	result := make([]string, 0, len(users))
	for _, u := range users {
		result = append(result, u.Login)
	}
	return result, nil
}

// AddComment implements issues.Client.AddComment for GitHub.
func (ic *IssuesClient) AddComment(info *issues.RepoInfo, number int, body string) (*issues.IssueComment, error) {
	ghInfo := ic.info
	if info != nil && info.Owner != "" && info.Repo != "" {
		ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
	}

	type commentPayload struct {
		Body string `json:"body"`
	}
	payload := commentPayload{Body: body}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/comments",
		ghInfo.Owner, ghInfo.Repo, number)
	resp, err := ic.c.doRequest("POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}

	bodyBytes, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var ghComment ghIssueComment
	if err := json.Unmarshal(bodyBytes, &ghComment); err != nil {
		return nil, fmt.Errorf("failed to parse comment: %w", err)
	}

	result := convertGHIssueComment(ghComment)
	return &result, nil
}
