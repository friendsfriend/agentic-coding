package github

import (
	"crypto/sha1"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/friendsfriend/devenv/pkg/changerequest"
)

func parseDiffLinesToChangeRequest(patch, filePath string) []changerequest.DiffLine {
	if patch == "" {
		return nil
	}

	var diffLines []changerequest.DiffLine
	lines := strings.Split(patch, "\n")

	var currentOldLine int
	var currentNewLine int

	for _, line := range lines {
		if len(line) == 0 {
			continue
		}

		if strings.HasPrefix(line, "@@") {
			match := regexp.MustCompile(`@@ -(\d+),?\d* \+(\d+),?\d* @@`).FindStringSubmatch(line)
			if len(match) >= 3 {
				currentOldLine, _ = strconv.Atoi(match[1])
				currentNewLine, _ = strconv.Atoi(match[2])
			}
			continue
		}

		if strings.HasPrefix(line, "---") || strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "\\") {
			continue
		}

		var dl changerequest.DiffLine
		dl.Text = line

		if strings.HasPrefix(line, "+") {
			dl.Type = "new"
			newLineVal := currentNewLine
			dl.NewLine = &newLineVal
			dl.LineCode = generateLineCode(filePath, &newLineVal, nil)
			currentNewLine++
		} else if strings.HasPrefix(line, "-") {
			dl.Type = "old"
			oldLineVal := currentOldLine
			dl.OldLine = &oldLineVal
			dl.LineCode = generateLineCode(filePath, nil, &oldLineVal)
			currentOldLine++
		} else {
			dl.Type = "match"
			oldLineVal := currentOldLine
			newLineVal := currentNewLine
			dl.OldLine = &oldLineVal
			dl.NewLine = &newLineVal
			dl.LineCode = generateLineCode(filePath, &newLineVal, &oldLineVal)
			currentOldLine++
			currentNewLine++
		}

		diffLines = append(diffLines, dl)
	}

	return diffLines
}

func generateLineCode(filePath string, newLine *int, oldLine *int) string {
	oldStr := ""
	if oldLine != nil {
		oldStr = strconv.Itoa(*oldLine)
	}
	newStr := ""
	if newLine != nil {
		newStr = strconv.Itoa(*newLine)
	}

	content := fmt.Sprintf("github:%s:%s:%s", filePath, oldStr, newStr)
	hash := sha1.New()
	hash.Write([]byte(content))
	return fmt.Sprintf("%x", hash.Sum(nil))
}
