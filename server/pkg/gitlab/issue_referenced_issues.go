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

// parseReferencedIssueRefs extracts #123 issue references from body text.
func parseReferencedIssueRefs(body string) []int {
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

// GetIssueReferencedIssues returns issues referenced in an issue's body.
// It parses #123 references and fetches each as an issue.
func (ic *IssuesClient) GetIssueReferencedIssues(info *issues.RepoInfo, number int) ([]issues.Issue, error) {
	proj := ic.project
	if info != nil && info.Namespace != "" && info.Project != "" {
		proj = &ProjectInfo{
			Host:      info.Host,
			Namespace: info.Namespace,
			Project:   info.Project,
		}
	}

	issue, err := ic.GetIssue(info, number)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch issue #%d: %w", number, err)
	}

	refs := parseReferencedIssueRefs(issue.Description)
	debugLog("GitLab GetIssueReferencedIssues(#%d): found %d references", number, len(refs))

	if len(refs) == 0 {
		return []issues.Issue{}, nil
	}

	var results []issues.Issue
	seen := make(map[int]bool)

	projectPath := url.QueryEscape(fmt.Sprintf("%s/%s", proj.Namespace, proj.Project))

	for _, refIID := range refs {
		if seen[refIID] {
			continue
		}
		seen[refIID] = true

		apiURL := fmt.Sprintf("%s/api/v4/projects/%s/issues/%d",
			ic.c.baseURL, projectPath, refIID)

		body, statusCode, err := ic.doGet(apiURL)
		if err != nil {
			log.Printf("[WARN] GitLab GetIssueReferencedIssues: failed to fetch #%d: %v", refIID, err)
			continue
		}

		if statusCode != http.StatusOK {
			continue
		}

		var glIss glIssue
		if err := json.Unmarshal(body, &glIss); err != nil {
			continue
		}

		result := convertGLIssue(glIss)
		results = append(results, result)
	}

	return results, nil
}
