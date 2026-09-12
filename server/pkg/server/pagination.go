package server

import "strconv"

const (
	defaultPage    = 1
	defaultPerPage = 50
	maxPerPage     = 100
)

func parsePage(value string) int {
	if value == "" {
		return defaultPage
	}
	page, err := strconv.Atoi(value)
	if err != nil || page < 1 {
		return defaultPage
	}
	return page
}

func parsePerPage(value string) int {
	if value == "" {
		return defaultPerPage
	}
	perPage, err := strconv.Atoi(value)
	if err != nil || perPage < 1 {
		return defaultPerPage
	}
	if perPage > maxPerPage {
		return maxPerPage
	}
	return perPage
}
