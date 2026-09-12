package issues

import "time"

// IssueComment represents a single comment on an issue.
type IssueComment struct {
	ID     int    `json:"id"`
	Body   string `json:"body"`
	Author struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	System    bool      `json:"system"`
}

// IssueCommentListResult holds the paginated response from listing issue comments.
type IssueCommentListResult struct {
	Comments    []IssueComment `json:"items"`
	TotalCount  int            `json:"totalCount"`
	TotalPages  int            `json:"totalPages"`
	CurrentPage int            `json:"currentPage"`
	PerPage     int            `json:"perPage"`
}
