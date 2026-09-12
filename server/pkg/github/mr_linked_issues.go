package github

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/friendsfriend/devenv/pkg/issues"
)

// parseIssueReferences extracts issue numbers from a PR body using the same
// closing keyword and bare # patterns used for issue body parsing.
// We reuse parseClosingReferences for keyword-based matches and add bare #.
func parseIssueReferences(body string) []int {
	return parseClosingReferences(body)
}

// GetChangeRequestLinkedIssues returns issues linked to a pull request.
// It parses the PR body for issue references, fetches each referenced item,
// and filters to only issues (excludes PRs).
func (ic *IssuesClient) GetChangeRequestLinkedIssues(ghInfo *RepoInfo, prNumber int) ([]issues.Issue, error) {
	// Fetch the PR to get its body/description
	pr, err := ic.c.GetPullRequest(ghInfo, prNumber)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch PR #%d: %w", prNumber, err)
	}

	refs := parseIssueReferences(pr.Description)
	debugLog("GitHub GetChangeRequestLinkedIssues(!%d): found %d issue references", prNumber, len(refs))

	if len(refs) == 0 {
		return []issues.Issue{}, nil
	}

	var results []issues.Issue
	seen := make(map[int]bool)

	for _, issueNum := range refs {
		if seen[issueNum] {
			continue
		}
		seen[issueNum] = true

		// Fetch as issue via the issues API
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d",
			ghInfo.Owner, ghInfo.Repo, issueNum)

		resp, err := ic.c.doRequest("GET", apiURL, nil)
		if err != nil {
			log.Printf("[WARN] GitHub GetChangeRequestLinkedIssues: failed to fetch issue #%d: %v", issueNum, err)
			continue
		}

		body, err := readBody(resp)
		if err != nil {
			continue
		}

		if resp.StatusCode != http.StatusOK {
			continue
		}

		var ghIss ghIssue
		if err := json.Unmarshal(body, &ghIss); err != nil {
			continue
		}

		// Skip if it's a pull request (PRs have pull_request field set)
		if ghIss.PullRequest != nil {
			continue
		}

		results = append(results, convertGHIssue(ghIss))
	}

	return results, nil
}
