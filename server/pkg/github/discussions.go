package github

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

// fetchPRTimelineEvents fetches timeline events for a PR from GitHub's Issue Timeline API.
// The timeline includes both comments (event="commented") and events (labeled, assigned, etc.).
// We paginate up to maxPages (3 pages × 100 = 300 items, enough for most PRs).
func (c *client) fetchPRTimelineEvents(info *RepoInfo, prNumber int) ([]ghTimelineEvent, error) {
	var allEvents []ghTimelineEvent
	maxPages := 3

	for page := 1; page <= maxPages; page++ {
		apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/timeline?per_page=100&page=%d",
			info.Owner, info.Repo, prNumber, page)

		resp, err := c.doRequest("GET", apiURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch timeline events: %w", err)
		}

		body, err := readBody(resp)
		if err != nil {
			return nil, err
		}

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GitHub API error fetching timeline (status %d): %s", resp.StatusCode, string(body))
		}

		var pageEvents []ghTimelineEvent
		if err := json.Unmarshal(body, &pageEvents); err != nil {
			return nil, fmt.Errorf("failed to parse timeline events: %w", err)
		}

		allEvents = append(allEvents, pageEvents...)

		// If response has fewer items than per_page, we're on the last page
		if len(pageEvents) < 100 {
			break
		}
	}

	return allEvents, nil
}

// timelineEventToBody converts a GitHub timeline event into a human-readable system note body,
// matching the style of GitLab system notes so the TUI DiscussionsView renders them uniformly.
func timelineEventToBody(event *ghTimelineEvent) string {
	switch event.Event {
	case "labeled":
		if event.Label != nil {
			return fmt.Sprintf("added ~%s label", event.Label.Name)
		}
		return "added label"
	case "unlabeled":
		if event.Label != nil {
			return fmt.Sprintf("removed ~%s label", event.Label.Name)
		}
		return "removed label"
	case "assigned":
		if event.Assignee != nil {
			return fmt.Sprintf("assigned to @%s", event.Assignee.Login)
		}
		return "assigned"
	case "unassigned":
		if event.Assignee != nil {
			return fmt.Sprintf("unassigned @%s", event.Assignee.Login)
		}
		return "unassigned"
	case "milestoned":
		if event.Milestone != nil {
			return fmt.Sprintf("added to milestone **%s**", event.Milestone.Title)
		}
		return "added to milestone"
	case "demilestoned":
		if event.Milestone != nil {
			return fmt.Sprintf("removed from milestone **%s**", event.Milestone.Title)
		}
		return "removed from milestone"
	case "renamed":
		if event.Rename != nil {
			return fmt.Sprintf("changed title from **%s** to **%s**", event.Rename.From, event.Rename.To)
		}
		return "changed title"
	case "locked":
		return "locked the conversation"
	case "unlocked":
		return "unlocked the conversation"
	case "review_requested":
		if event.RequestedReviewer != nil {
			return fmt.Sprintf("requested review from @%s", event.RequestedReviewer.Login)
		}
		return "requested review"
	case "review_request_removed":
		if event.RequestedReviewer != nil {
			return fmt.Sprintf("removed review request from @%s", event.RequestedReviewer.Login)
		}
		return "removed review request"
	case "ready_for_review":
		return "marked as ready for review"
	case "merged":
		return "merged the commit"
	case "closed":
		return "closed"
	case "reopened":
		return "reopened"
	case "head_ref_deleted":
		return "deleted the head branch"
	case "head_ref_restored":
		return "restored the head branch"
	case "cross-referenced":
		if event.Source != nil && event.Source.Issue != nil {
			return fmt.Sprintf("mentioned in #%d %s", event.Source.Issue.Number, event.Source.Issue.Title)
		}
		return "mentioned in another issue"
	case "base_ref_changed":
		return "changed the base branch"
	case "reviewed":
		return "submitted a review"
	case "committed":
		return "added a commit"
	case "comment_removed":
		return "removed a comment"
	case "marked_as_duplicate":
		return "marked as duplicate"
	case "unmarked_as_duplicate":
		return "unmarked as duplicate"
	case "converted_note_to_issue":
		return "converted to issue"
	case "transferred":
		return "transferred"
	case "subscribed":
		return "subscribed"
	case "unsubscribed":
		return "unsubscribed"
	case "pinned":
		return "pinned"
	case "unpinned":
		return "unpinned"
	case "automatic_base_change_failed":
		return "automatic base change failed"
	case "automatic_base_change_succeeded":
		return "automatic base change succeeded"
	default:
		// For unknown events, include the raw event name so it's visible
		return event.Event
	}
}

// GetDiscussions implements changerequest.Client.GetDiscussions.
func (c *client) GetDiscussions(info *changerequest.RepoInfo, mrNumber int) ([]changerequest.Discussion, error) {
	ghInfo, err := FromChangeRequest(info)
	if err != nil {
		return nil, err
	}

	reviewComments, err := c.fetchPRReviewComments(ghInfo, mrNumber)
	if err != nil {
		return nil, err
	}

	issueComments, err := c.fetchPRIssueComments(ghInfo, mrNumber)
	if err != nil {
		return nil, err
	}

	timelineEvents, err := c.fetchPRTimelineEvents(ghInfo, mrNumber)
	if err != nil {
		// Timeline is a nice-to-have; log the error, don't fail the whole request
		log.Printf("[WARN] Failed to fetch timeline events for PR #%d: %v", mrNumber, err)
		timelineEvents = nil
	}

	// Build a set of issue comment IDs so we skip "commented" events that duplicate them
	issueCommentIDs := make(map[int]bool)
	for _, ic := range issueComments {
		issueCommentIDs[ic.ID] = true
	}

	var discussions []changerequest.Discussion

	// 1. Build discussion threads from review comments (inline code review)
	rootByID := make(map[int]*changerequest.Discussion)
	var orderedRoots []int

	for i := range reviewComments {
		rc := &reviewComments[i]
		if rc.InReplyToID == nil {
			d := changerequest.Discussion{
				ID:             strconv.Itoa(rc.ID),
				IndividualNote: false,
				Notes: []changerequest.Note{
					convertReviewCommentToChangeRequest(rc),
				},
			}
			discussions = append(discussions, d)
			rootByID[rc.ID] = &discussions[len(discussions)-1]
			orderedRoots = append(orderedRoots, rc.ID)
		}
	}

	for i := range reviewComments {
		rc := &reviewComments[i]
		if rc.InReplyToID != nil {
			parentID := *rc.InReplyToID
			if d, ok := rootByID[parentID]; ok {
				d.Notes = append(d.Notes, convertReviewCommentToChangeRequest(rc))
			}
		}
	}

	_ = orderedRoots

	// 2. Add issue comments (general PR comments)
	for i := range issueComments {
		ic := &issueComments[i]
		d := changerequest.Discussion{
			ID:             strconv.Itoa(ic.ID),
			IndividualNote: true,
			Notes: []changerequest.Note{
				{
					ID:   ic.ID,
					Type: "DiscussionNote",
					Body: ic.Body,
					Author: changerequest.NoteAuthor{
						Username: ic.User.Login,
						Name:     ic.User.Login,
					},
					CreatedAt:  ic.CreatedAt,
					UpdatedAt:  ic.UpdatedAt,
					Resolvable: false,
					Resolved:   false,
				},
			},
		}
		discussions = append(discussions, d)
	}

	// 3. Add timeline events as system notes (skip "commented" events already covered by issue comments)
	for i := range timelineEvents {
		e := &timelineEvents[i]
		// Skip comment-type events — already in issueComments
		if e.Event == "commented" && issueCommentIDs[e.ID] {
			continue
		}

		body := timelineEventToBody(e)
		d := changerequest.Discussion{
			ID:             fmt.Sprintf("timeline-%d", e.ID),
			IndividualNote: true,
			Notes: []changerequest.Note{
				{
					ID:        e.ID,
					Type:      "TimelineEvent",
					Body:      body,
					System:    true,
					CreatedAt: e.CreatedAt,
					UpdatedAt: e.CreatedAt,
					Author: changerequest.NoteAuthor{
						Username: e.Actor.Login,
						Name:     e.Actor.Login,
					},
				},
			},
		}
		discussions = append(discussions, d)
	}

	debugLog("Fetched %d discussions (incl. %d timeline events) for PR #%d",
		len(discussions), len(timelineEvents), mrNumber)
	return discussions, nil
}

func (c *client) fetchPRReviewComments(info *RepoInfo, prNumber int) ([]ghPRReviewComment, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/pulls/%d/comments?per_page=100",
		info.Owner, info.Repo, prNumber)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch review comments: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var comments []ghPRReviewComment
	if err := json.Unmarshal(body, &comments); err != nil {
		return nil, fmt.Errorf("failed to parse review comments: %w", err)
	}
	return comments, nil
}

func (c *client) fetchPRIssueComments(info *RepoInfo, prNumber int) ([]ghIssueComment, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/issues/%d/comments?per_page=100",
		info.Owner, info.Repo, prNumber)

	resp, err := c.doRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch issue comments: %w", err)
	}

	body, err := readBody(resp)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API error (status %d): %s", resp.StatusCode, string(body))
	}

	var comments []ghIssueComment
	if err := json.Unmarshal(body, &comments); err != nil {
		return nil, fmt.Errorf("failed to parse issue comments: %w", err)
	}
	return comments, nil
}
func convertReviewCommentToChangeRequest(rc *ghPRReviewComment) changerequest.Note {
	return changerequest.Note{
		ID:   rc.ID,
		Type: "DiffNote",
		Body: rc.Body,
		Author: changerequest.NoteAuthor{
			Username: rc.User.Login,
			Name:     rc.User.Login,
		},
		CreatedAt:  rc.CreatedAt,
		UpdatedAt:  rc.UpdatedAt,
		Resolvable: true,
		Resolved:   false,
	}
}
