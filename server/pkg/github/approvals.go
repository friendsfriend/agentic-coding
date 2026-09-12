package github

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// GetPRApprovals fetches review-based approvals for a pull request and returns
// an MergeRequestApprovals struct compatible with the GitLab shape.
func (c *client) GetPRApprovals(info *RepoInfo, prNumber int) (*MergeRequestApprovals, error) {
	if info == nil {
		return nil, fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/reviews?per_page=100",
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

	var reviews []ghReview
	if err := json.Unmarshal(body, &reviews); err != nil {
		return nil, fmt.Errorf("failed to parse reviews: %w", err)
	}

	// Collect the latest review state per user.
	// A user might approve and then dismiss — only the latest state counts.
	latestByUser := make(map[string]string) // login → state
	for _, r := range reviews {
		if r.User.Login == "" {
			continue
		}
		latestByUser[r.User.Login] = r.State
	}

	approvals := &MergeRequestApprovals{
		ApprovalsRequired: 1, // sensible default — GitHub enforces this at repo level
		ApprovedBy: []struct {
			User struct {
				Name     string `json:"name"`
				Username string `json:"username"`
			} `json:"user"`
		}{},
	}

	for login, state := range latestByUser {
		if state == "APPROVED" {
			entry := struct {
				User struct {
					Name     string `json:"name"`
					Username string `json:"username"`
				} `json:"user"`
			}{}
			entry.User.Name = login
			entry.User.Username = login
			approvals.ApprovedBy = append(approvals.ApprovedBy, entry)
		}
	}

	if len(approvals.ApprovedBy) >= approvals.ApprovalsRequired {
		approvals.ApprovalsLeft = 0
	} else {
		approvals.ApprovalsLeft = approvals.ApprovalsRequired - len(approvals.ApprovedBy)
	}

	return approvals, nil
}

// Approve implements changerequest.Client.Approve.
func (c *client) Approve(info *changerequest.RepoInfo, mrNumber int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.approvePRInternal(ghInfo, mrNumber)
}

func (c *client) approvePRInternal(info *RepoInfo, prNumber int) error {
	if info == nil {
		return fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/reviews",
		info.Owner, info.Repo, prNumber)

	payload := map[string]string{"event": "APPROVE"}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := c.doRequest("POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return err
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// Unapprove implements changerequest.Client.Unapprove.
func (c *client) Unapprove(info *changerequest.RepoInfo, mrNumber int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	return c.unapprovePRInternal(ghInfo, mrNumber)
}

func (c *client) unapprovePRInternal(info *RepoInfo, prNumber int) error {
	if info == nil {
		return fmt.Errorf("repo info is nil")
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/reviews?per_page=100",
		info.Owner, info.Repo, prNumber)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to fetch reviews: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return err
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var reviews []ghReview
	if err := json.Unmarshal(body, &reviews); err != nil {
		return fmt.Errorf("failed to parse reviews: %w", err)
	}

	var reviewIDToDissmiss int
	for i := len(reviews) - 1; i >= 0; i-- {
		r := reviews[i]
		if r.State == "APPROVED" && (c.username == "" || r.User.Login == c.username) {
			reviewIDToDissmiss = r.ID
			break
		}
	}

	if reviewIDToDissmiss == 0 {
		return fmt.Errorf("no APPROVED review found to dismiss")
	}

	dismissURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/reviews/%d/dismissals",
		info.Owner, info.Repo, prNumber, reviewIDToDissmiss)

	dismissPayload := map[string]string{"message": "Unapproved via devenv-cli"}
	jsonPayload, err := json.Marshal(dismissPayload)
	if err != nil {
		return fmt.Errorf("failed to marshal dismiss payload: %w", err)
	}

	dismissResp, err := c.doRequest("PUT", dismissURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to dismiss review: %w", err)
	}

	dismissBody, err := readBody(dismissResp)
	if err != nil {
		return err
	}

	if dismissResp.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub API error dismissing review (status %d): %s",
			dismissResp.StatusCode, string(dismissBody))
	}

	return nil
}

// ToggleApproval implements changerequest.Client.ToggleApproval.
func (c *client) ToggleApproval(info *changerequest.RepoInfo, mrNumber int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}
	approvals, err := c.GetPRApprovals(ghInfo, mrNumber)
	if err != nil {
		return fmt.Errorf("failed to get current approvals: %w", err)
	}

	alreadyApproved := false
	for _, a := range approvals.ApprovedBy {
		if a.User.Username == c.username {
			alreadyApproved = true
			break
		}
	}

	if alreadyApproved {
		return c.unapprovePRInternal(ghInfo, mrNumber)
	}
	return c.approvePRInternal(ghInfo, mrNumber)
}
