package github

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// GetChangeRequestChanges implements changerequest.Client.GetChangeRequestChanges.
func (c *client) GetChangeRequestChanges(info *changerequest.RepoInfo, mrNumber int) ([]changerequest.ChangeRequestChange, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/files?per_page=100",
		ghInfo.Owner, ghInfo.Repo, mrNumber)

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

	var files []ghPRFile
	if err := json.Unmarshal(body, &files); err != nil {
		return nil, fmt.Errorf("failed to parse PR files: %w", err)
	}

	changes := make([]changerequest.ChangeRequestChange, 0, len(files))
	for _, f := range files {
		ch := changerequest.ChangeRequestChange{
			NewPath:      f.Filename,
			OldPath:      f.Filename,
			AMode:        "100644",
			BMode:        "100644",
			Diff:         f.Patch,
			LinesAdded:   f.Additions,
			LinesDeleted: f.Deletions,
		}

		switch f.Status {
		case "added":
			ch.NewFile = true
		case "removed":
			ch.DeletedFile = true
			ch.OldPath = f.Filename
			ch.NewPath = f.Filename
		case "renamed":
			ch.RenamedFile = true
			if f.PreviousFilename != "" {
				ch.OldPath = f.PreviousFilename
			}
		}

		if f.Patch != "" {
			ch.DiffLines = parseDiffLinesToChangeRequest(f.Patch, f.Filename)
		}

		changes = append(changes, ch)
	}

	return changes, nil
}
