package resources

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvFileLoadUpsertAndRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	initial := "# keep\nFOO=bar\nTOKEN='old value'\n"
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}

	vars, err := LoadEnvFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if vars["FOO"] != "bar" || vars["TOKEN"] != "old value" {
		t.Fatalf("unexpected vars: %#v", vars)
	}

	if err := UpsertEnvFile(path, map[string]string{"TOKEN": "a'b\\c #x", "NEW": "value"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "# keep\n") || !strings.Contains(text, "FOO=bar\n") {
		t.Fatalf("unrelated content not preserved:\n%s", text)
	}
	vars, err = LoadEnvFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if vars["TOKEN"] != "a'b\\c #x" || vars["NEW"] != "value" {
		t.Fatalf("unexpected updated vars: %#v", vars)
	}

	if err := RemoveEnvFileKeys(path, []string{"TOKEN"}); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text = string(data)
	if strings.Contains(text, "TOKEN=") || !strings.Contains(text, "FOO=bar") || !strings.Contains(text, "NEW=") {
		t.Fatalf("unexpected removal result:\n%s", text)
	}
}

func TestUpsertEnvFileCreatesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := UpsertEnvFile(path, map[string]string{"A": "b"}); err != nil {
		t.Fatal(err)
	}
	vars, err := LoadEnvFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if vars["A"] != "b" {
		t.Fatalf("unexpected vars: %#v", vars)
	}
}

func TestSubstituteVarsWithWarnings(t *testing.T) {
	t.Run("all variables resolved", func(t *testing.T) {
		result, missing := SubstituteVarsWithWarnings("db=${DB_HOST}", map[string]string{"DB_HOST": "localhost"})
		if result != "db=localhost" {
			t.Fatalf("expected db=localhost, got %q", result)
		}
		if len(missing) != 0 {
			t.Fatalf("expected no missing vars, got %v", missing)
		}
	})

	t.Run("single missing variable", func(t *testing.T) {
		result, missing := SubstituteVarsWithWarnings("db=${DB_HOST}:${DB_PORT}", map[string]string{"DB_HOST": "localhost"})
		if result != "db=localhost:${DB_PORT}" {
			t.Fatalf("expected db=localhost:${DB_PORT}, got %q", result)
		}
		if len(missing) != 1 || missing[0] != "DB_PORT" {
			t.Fatalf("expected [DB_PORT], got %v", missing)
		}
	})

	t.Run("multiple missing variables", func(t *testing.T) {
		_, missing := SubstituteVarsWithWarnings("${A}-${B}-${C}", map[string]string{"B": "val"})
		if len(missing) != 2 {
			t.Fatalf("expected 2 missing vars, got %d: %v", len(missing), missing)
		}
		missingSet := make(map[string]bool)
		for _, m := range missing {
			missingSet[m] = true
		}
		if !missingSet["A"] || !missingSet["C"] {
			t.Fatalf("expected A and C missing, got %v", missing)
		}
	})

	t.Run("empty placeholder ignored", func(t *testing.T) {
		result, missing := SubstituteVarsWithWarnings("test-${}-end", map[string]string{})
		if result != "test-${}-end" {
			t.Fatalf("expected test-${}-end, got %q", result)
		}
		if len(missing) != 0 {
			t.Fatalf("expected no missing vars for empty placeholder, got %v", missing)
		}
	})

	t.Run("no placeholders", func(t *testing.T) {
		result, missing := SubstituteVarsWithWarnings("hello world", map[string]string{"A": "b"})
		if result != "hello world" {
			t.Fatalf("expected hello world, got %q", result)
		}
		if len(missing) != 0 {
			t.Fatalf("expected no missing vars, got %v", missing)
		}
	})
}
