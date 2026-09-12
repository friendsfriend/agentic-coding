package github

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

func (c *client) Close(info *changerequest.RepoInfo, mrNumber int) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d",
		ghInfo.Owner, ghInfo.Repo, mrNumber)

	payload := map[string]string{"state": "closed"}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := c.doRequest("PATCH", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *client) Rebase(info *changerequest.RepoInfo, mrNumber int) error {
	return fmt.Errorf("server-side rebase is not supported on GitHub")
}

func (c *client) CreateDiffComment(info *changerequest.RepoInfo, mrNumber int, body string, position *changerequest.DiffPosition) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/comments",
		ghInfo.Owner, ghInfo.Repo, mrNumber)

	payload := map[string]interface{}{
		"body": body,
	}

	if position != nil {
		side := "RIGHT"
		if position.OldLine != nil {
			side = "LEFT"
		}
		payload["commit_id"] = position.HeadSHA
		payload["path"] = position.NewPath
		payload["side"] = side
		if position.OldLine != nil {
			payload["line"] = *position.OldLine
		} else if position.NewLine != nil {
			payload["line"] = *position.NewLine
		}
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := c.doRequest("POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *client) ReplyToDiscussion(info *changerequest.RepoInfo, mrNumber int, discussionID string, body string) error {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return err
	}

	replyID, err := strconv.Atoi(discussionID)
	if err != nil {
		return fmt.Errorf("invalid discussion ID: %w", err)
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/comments",
		ghInfo.Owner, ghInfo.Repo, mrNumber)

	payload := map[string]interface{}{
		"body":        body,
		"in_reply_to": replyID,
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := c.doRequest("POST", apiURL, strings.NewReader(string(jsonPayload)))
	if err != nil {
		return fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

func (c *client) ResolveDiscussion(info *changerequest.RepoInfo, mrNumber int, discussionID string, resolved bool) error {
	return fmt.Errorf("resolving discussions is not supported on GitHub")
}
