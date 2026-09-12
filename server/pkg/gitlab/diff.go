package gitlab

import (
	"crypto/sha1"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// calculateLineStats calculates lines added and deleted from the diff
func (c *ChangeRequestChange) calculateLineStats() {
	if c.Diff == "" {
		return
	}

	added := 0
	deleted := 0

	lines := strings.Split(c.Diff, "\n")
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		if line[0] == '+' && !strings.HasPrefix(line, "+++") {
			added++
		} else if line[0] == '-' && !strings.HasPrefix(line, "---") {
			deleted++
		}
	}

	c.LinesAdded = added
	c.LinesDeleted = deleted
}

// parseDiffLines parses the unified diff and generates line codes for each line
// Note: We generate line_code but GitLab requires it to match their internal codes
// For now, we parse the structure but don't use line_code in API calls
func (c *ChangeRequestChange) parseDiffLines(baseSHA string) {
	if c.Diff == "" {
		debugLog("parseDiffLines: Empty diff for %s", c.NewPath)
		return
	}

	if baseSHA == "" {
		debugLog("parseDiffLines: Empty baseSHA for %s", c.NewPath)
		return
	}

	var diffLines []DiffLine
	lines := strings.Split(c.Diff, "\n")

	debugLog("parseDiffLines: Parsing %d lines for %s with baseSHA=%s", len(lines), c.NewPath, baseSHA[:8])

	var currentOldLine int
	var currentNewLine int

	for _, line := range lines {
		if len(line) == 0 {
			continue
		}

		// Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
		if strings.HasPrefix(line, "@@") {
			match := regexp.MustCompile(`@@ -(\d+),?\d* \+(\d+),?\d* @@`).FindStringSubmatch(line)
			if len(match) >= 3 {
				currentOldLine, _ = strconv.Atoi(match[1])
				currentNewLine, _ = strconv.Atoi(match[2])
			}
			continue
		}

		// Skip file headers
		if strings.HasPrefix(line, "---") || strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "\\") {
			continue
		}

		// Determine line type and numbers
		var diffLine DiffLine
		diffLine.Text = line

		if strings.HasPrefix(line, "+") {
			// Added line
			diffLine.Type = "new"
			newLineVal := currentNewLine
			diffLine.NewLine = &newLineVal
			diffLine.LineCode = c.generateLineCode(baseSHA, &newLineVal, nil)
			currentNewLine++
		} else if strings.HasPrefix(line, "-") {
			// Deleted line
			diffLine.Type = "old"
			oldLineVal := currentOldLine
			diffLine.OldLine = &oldLineVal
			diffLine.LineCode = c.generateLineCode(baseSHA, nil, &oldLineVal)
			currentOldLine++
		} else {
			// Context line (unchanged)
			diffLine.Type = "match"
			oldLineVal := currentOldLine
			newLineVal := currentNewLine
			diffLine.OldLine = &oldLineVal
			diffLine.NewLine = &newLineVal
			diffLine.LineCode = c.generateLineCode(baseSHA, &newLineVal, &oldLineVal)
			currentOldLine++
			currentNewLine++
		}

		diffLines = append(diffLines, diffLine)
	}

	c.DiffLines = diffLines
}

// generateLineCode generates a GitLab-compatible line_code
// Format: SHA1("<base_sha>:<old_path>:<old_line>:<new_path>:<new_line>")
// Note: GitLab validates these strictly, so we generate them but don't use them in API calls
func (c *ChangeRequestChange) generateLineCode(baseSHA string, newLine *int, oldLine *int) string {
	oldLineStr := ""
	if oldLine != nil {
		oldLineStr = strconv.Itoa(*oldLine)
	}

	newLineStr := ""
	if newLine != nil {
		newLineStr = strconv.Itoa(*newLine)
	}

	// GitLab format: base_sha:old_path:old_line:new_path:new_line
	content := fmt.Sprintf("%s:%s:%s:%s:%s", baseSHA, c.OldPath, oldLineStr, c.NewPath, newLineStr)

	hash := sha1.New()
	hash.Write([]byte(content))
	return fmt.Sprintf("%x", hash.Sum(nil))
}
