package github

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"github.com/friendsfriend/devenv/pkg/changerequest"
	"github.com/friendsfriend/devenv/pkg/issues"
)

// closingRefPatterns matches GitHub closing keyword patterns in issue bodies.
var closingRefPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(?:close(?:s|d)?(?:\s+by)?\s*:?\s*#?(\d+))\b`),
	regexp.MustCompile(`(?i)(?:fix(?:es|ed)?\s*:?\s*#?(\d+))\b`),
	regexp.MustCompile(`(?i)(?:resolve(?:s|d)?\s*:?\s*#?(\d+))\b`),
	regexp.MustCompile(`(?i)(?:close|fix|resolve|closed by|fixes|resolves|closes)\s+(?:issue\s+)?#?(\d+)\b`),

	// "GH-123" shorthand
	regexp.MustCompile(`(?i)GH[-\s]?(\d+)\b`),

	// Cross-repo: "owner/repo#123" — number is capture group 1
	regexp.MustCompile(`(?i)(?:[a-zA-Z0-9_.\-]+/[a-zA-Z0-9_.\-]+)#(\d+)\b`),

	// Bare "#123" — catches simple PR/issue cross-references without closing keywords.
	// Non-PR numbers silently fail in GetPullRequest; dedup handles overlap with keywords.
	regexp.MustCompile(`#(\d+)\b`),
}

// parseClosingReferences extracts PR/issue numbers from an issue description.
func parseClosingReferences(body string) []int {
	seen := make(map[int]bool)
	var refs []int

	for _, re := range closingRefPatterns {
		matches := re.FindAllStringSubmatch(body, -1)
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
	}

	return refs
}

// ghCrossReferencedEvent represents a cross-referenced event from the issue timeline.
type ghCrossReferencedEvent struct {
	Event     string `json:"event"`
	CreatedAt string `json:"created_at"`
	Source    *struct {
		Type  string `json:"type"`
		Issue *struct {
			Number      int       `json:"number"`
			Title       string    `json:"title"`
			PullRequest *struct{} `json:"pull_request,omitempty"` // non-nil = PR
		} `json:"issue"`
	} `json:"source"`
}

// fetchCrossReferencedPRs fetches the issue timeline and extracts PR numbers
// from cross-referenced events. This catches PRs that reference this issue
// via closing keywords in the PR body, the "Development" sidebar link, etc.
func (ic *IssuesClient) fetchCrossReferencedPRs(ghInfo *RepoInfo, issueNumber int) []int {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/timeline?per_page=100",
		ghInfo.Owner, ghInfo.Repo, issueNumber)

	resp, err := ic.c.doRequest("GET", apiURL, nil)
	if err != nil {
		log.Printf("[WARN] GitHub fetchCrossReferencedPRs: failed to fetch timeline for #%d: %v", issueNumber, err)
		return nil
	}

	body, err := readBody(resp)
	if err != nil {
		return nil
	}

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	// Timeline includes various event types; we're looking for "cross-referenced"
	var events []ghCrossReferencedEvent
	if err := json.Unmarshal(body, &events); err != nil {
		log.Printf("[WARN] GitHub fetchCrossReferencedPRs: failed to parse timeline: %v", err)
		return nil
	}

	seen := make(map[int]bool)
	var refs []int

	for _, evt := range events {
		if evt.Event != "cross-referenced" || evt.Source == nil || evt.Source.Issue == nil {
			continue
		}
		// Only include if the source is a Pull Request (has pull_request field)
		if evt.Source.Issue.PullRequest == nil {
			continue
		}
		num := evt.Source.Issue.Number
		if !seen[num] {
			seen[num] = true
			refs = append(refs, num)
			debugLog("GitHub fetchCrossReferencedPRs: found cross-referenced PR #%d", num)
		}
	}

	return refs
}

// fetchPRDetails fetches a single PR and converts to changerequest.ChangeRequest.
func (ic *IssuesClient) fetchPRDetails(ghInfo *RepoInfo, prNum int) *changerequest.ChangeRequest {
	pr, err := ic.c.GetPullRequest(ghInfo, prNum)
	if err != nil {
		log.Printf("[WARN] GitHub GetIssueLinkedChangeRequests: failed to fetch PR #%d: %v", prNum, err)
		return nil
	}

	result := changerequest.ChangeRequest{
		ID:                          pr.ID,
		IID:                         pr.IID,
		Title:                       pr.Title,
		Description:                 pr.Description,
		SourceBranch:                pr.SourceBranch,
		TargetBranch:                pr.TargetBranch,
		State:                       pr.State,
		WebURL:                      pr.WebURL,
		CreatedAt:                   pr.CreatedAt,
		UpdatedAt:                   pr.UpdatedAt,
		MergeStatus:                 pr.MergeStatus,
		DetailedMergeStatus:         pr.DetailedMergeStatus,
		Draft:                       pr.Draft,
		WorkInProgress:              pr.WorkInProgress,
		HasConflicts:                pr.HasConflicts,
		BlockingDiscussionsResolved: pr.BlockingDiscussionsResolved,
		RebaseInProgress:            pr.RebaseInProgress,
		MergeError:                  pr.MergeError,
		ApproveStatus:               nil,
	}
	result.Author.Name = pr.Author.Name
	result.Author.Username = pr.Author.Username

	if pr.HeadPipeline != nil {
		result.HeadPipeline = &changerequest.PipelineRef{
			ID:     pr.HeadPipeline.ID,
			Status: pr.HeadPipeline.Status,
			WebURL: pr.HeadPipeline.WebURL,
		}
	}

	return &result
}

// GetIssueLinkedChangeRequests implements issues.Client.GetIssueLinkedChangeRequests for GitHub.
// It combines results from three sources:
//  1. Closing keywords in the issue body (closes/fixes/resolves #123)
//  2. Bare #123 references in the issue body
//  3. Cross-referenced events from the issue timeline (PRs that reference this issue)
func (ic *IssuesClient) GetIssueLinkedChangeRequests(info *issues.RepoInfo, number int) ([]changerequest.ChangeRequest, error) {
	ghInfo := ic.info
	if info != nil {
		if info.Owner != "" && info.Repo != "" {
			ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
		}
	}

	seen := make(map[int]bool)
	var results []changerequest.ChangeRequest

	// Source 1: Parse issue body for closing keywords and bare # references
	issue, err := ic.GetIssue(info, number)
	if err == nil {
		bodyRefs := parseClosingReferences(issue.Description)
		debugLog("GitHub GetIssueLinkedChangeRequests(#%d): %d references from body parsing", number, len(bodyRefs))

		for _, prNum := range bodyRefs {
			if seen[prNum] {
				continue
			}
			seen[prNum] = true
			if pr := ic.fetchPRDetails(ghInfo, prNum); pr != nil {
				results = append(results, *pr)
			}
		}
	} else {
		log.Printf("[WARN] GitHub GetIssueLinkedChangeRequests: failed to fetch issue #%d body: %v", number, err)
	}

	// Source 2: Issue timeline cross-referenced events
	// Catches PRs that reference this issue via PR body keywords or "Development" link
	timelineRefs := ic.fetchCrossReferencedPRs(ghInfo, number)
	debugLog("GitHub GetIssueLinkedChangeRequests(#%d): %d references from timeline", number, len(timelineRefs))

	for _, prNum := range timelineRefs {
		if seen[prNum] {
			continue
		}
		seen[prNum] = true
		if pr := ic.fetchPRDetails(ghInfo, prNum); pr != nil {
			results = append(results, *pr)
		}
	}

	return results, nil
}
