package github

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/friendsfriend/devenv/pkg/issues"
)

// GetIssueReferencedIssues returns issues referenced in an issue's body.
// It parses #123 references and fetches each as an issue, excluding PRs.
func (ic *IssuesClient) GetIssueReferencedIssues(info *issues.RepoInfo, number int) ([]issues.Issue, error) {
	ghInfo := ic.info
	if info != nil {
		if info.Owner != "" && info.Repo != "" {
			ghInfo = &RepoInfo{Owner: info.Owner, Repo: info.Repo}
		}
	}

	issue, err := ic.GetIssue(info, number)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch issue #%d: %w", number, err)
	}

	refs := parseClosingReferences(issue.Description)
	debugLog("GitHub GetIssueReferencedIssues(#%d): found %d references", number, len(refs))

	if len(refs) == 0 {
		return []issues.Issue{}, nil
	}

	var results []issues.Issue
	seen := make(map[int]bool)

	for _, refNum := range refs {
		if seen[refNum] {
			continue
		}
		seen[refNum] = true

		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d",
			ghInfo.Owner, ghInfo.Repo, refNum)

		resp, err := ic.c.doRequest("GET", apiURL, nil)
		if err != nil {
			log.Printf("[WARN] GitHub GetIssueReferencedIssues: failed to fetch #%d: %v", refNum, err)
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

		// Skip PRs — only include actual issues
		if ghIss.PullRequest != nil {
			continue
		}

		results = append(results, convertGHIssue(ghIss))
	}

	return results, nil
}
