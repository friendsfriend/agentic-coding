package resources

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCrossRuntimeFixtureManifestsParse(t *testing.T) {
	root := filepath.Join("..", "..", "testdata", "cross-runtime")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, entry.Name(), "profile.json"))
		if err != nil {
			t.Fatal(err)
		}
		var manifest map[string]any
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if manifest["name"] == nil {
			t.Fatalf("%s missing name", entry.Name())
		}
	}
}
