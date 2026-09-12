package issues

import "time"

// Issue represents a canonical issue across providers.
type Issue struct {
	ID          int    `json:"id"`
	IID         int    `json:"iid"`
	Title       string `json:"title"`
	Description string `json:"description"`
	State       string `json:"state"`
	WebURL      string `json:"web_url"`
	Author      struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"author"`
	Labels    []string `json:"labels"`
	Assignees []struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"assignees"`
	Milestone *struct {
		Title string `json:"title"`
	} `json:"milestone,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// IssueListResult holds the paginated response from listing issues.
type IssueListResult struct {
	Issues      []Issue `json:"items"`
	TotalCount  int     `json:"totalCount"`
	TotalPages  int     `json:"totalPages"`
	CurrentPage int     `json:"currentPage"`
	PerPage     int     `json:"perPage"`
}
