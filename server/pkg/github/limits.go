package github

const (
	defaultProviderLimit = 20
	maxProviderLimit     = 100
)

func clampProviderLimit(limit int) int {
	if limit <= 0 {
		return defaultProviderLimit
	}
	if limit > maxProviderLimit {
		return maxProviderLimit
	}
	return limit
}
