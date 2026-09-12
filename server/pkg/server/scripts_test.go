package server

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/friendsfriend/devenv/pkg/resources"
)

func TestBuildScriptTree(t *testing.T) {
	t.Parallel()

	scripts := []resources.ScriptFile{
		{
			Name:         "initialize.sh",
			RelativePath: "database/installer/initialize.sh",
			AbsolutePath: filepath.Join("/home", "user", "devenv", "scripts", "database", "installer", "initialize.sh"),
			Interpreter:  "bash",
		},
		{
			Name:         "homebrew.ps1",
			RelativePath: "packages/install/homebrew.ps1",
			AbsolutePath: filepath.Join("/home", "user", "devenv", "scripts", "packages", "install", "homebrew.ps1"),
			Interpreter:  "pwsh",
		},
		{
			Name:         "bootstrap.sh",
			RelativePath: "bootstrap.sh",
			AbsolutePath: filepath.Join("/home", "user", "devenv", "scripts", "bootstrap.sh"),
			Interpreter:  "bash",
		},
	}

	tree := buildScriptTree(scripts)
	if len(tree) != 3 {
		t.Fatalf("expected 3 root nodes, got %d", len(tree))
	}
	if tree[0].NodeType != "folder" || tree[0].Name != "database" {
		t.Fatalf("unexpected first root node: %+v", tree[0])
	}
	if len(tree[0].Children) != 1 || tree[0].Children[0].Name != "installer" {
		t.Fatalf("expected database/installer hierarchy, got %+v", tree[0].Children)
	}
	if len(tree[0].Children[0].Children) != 1 || tree[0].Children[0].Children[0].Name != "initialize.sh" {
		t.Fatalf("expected initialize.sh leaf, got %+v", tree[0].Children[0].Children)
	}
	if tree[2].NodeType != "script" || tree[2].RelativePath != "bootstrap.sh" {
		t.Fatalf("expected flat bootstrap script leaf, got %+v", tree[2])
	}
	// Check interpreter field replaces scriptType
	if tree[2].Interpreter != "bash" {
		t.Fatalf("expected interpreter 'bash' for bootstrap.sh, got %q", tree[2].Interpreter)
	}
	// Check the nested script also has interpreter
	if len(tree[0].Children[0].Children) > 0 && tree[0].Children[0].Children[0].Interpreter != "bash" {
		t.Fatalf("expected interpreter 'bash' for initialize.sh, got %q", tree[0].Children[0].Children[0].Interpreter)
	}
}

func TestResolveScriptExecutionPlan(t *testing.T) {
	t.Parallel()

	bashScript := resources.ScriptFile{
		RelativePath: "db/init.sh",
		AbsolutePath: filepath.Join("/home", "user", "devenv", "scripts", "db", "init.sh"),
		Directory:    filepath.Join("/home", "user", "devenv", "scripts", "db"),
		Interpreter:  "bash",
	}

	t.Run("on Unix executes script directly via shebang", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix-specific test")
		}
		t.Parallel()
		plan, err := resolveScriptExecutionPlan(bashScript, []string{"--env", "dev"}, "linux", func(bin string) (string, error) {
			return "/bin/" + bin, nil
		})
		if err != nil {
			t.Fatalf("resolveScriptExecutionPlan error = %v", err)
		}
		if plan.WorkingDir != bashScript.Directory {
			t.Fatalf("working dir mismatch: got %q want %q", plan.WorkingDir, bashScript.Directory)
		}
		// On Unix, the command is the script path itself (shebang handles it)
		if plan.Command != bashScript.AbsolutePath {
			t.Fatalf("expected command to be script path %q, got %q", bashScript.AbsolutePath, plan.Command)
		}
		if len(plan.Args) != 2 || plan.Args[0] != "--env" {
			t.Fatalf("unexpected args: %v", plan.Args)
		}
	})

	t.Run("Windows resolves interpreter and passes script path as arg", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("Windows-specific test")
		}
		t.Parallel()
		plan, err := resolveScriptExecutionPlan(bashScript, []string{"--env", "dev"}, "windows", func(bin string) (string, error) {
			if bin == "bash" {
				return "C:\\Program Files\\Git\\bin\\bash.exe", nil
			}
			return "", errors.New("not found")
		})
		if err != nil {
			t.Fatalf("resolveScriptExecutionPlan error = %v", err)
		}
		if plan.WorkingDir != bashScript.Directory {
			t.Fatalf("working dir mismatch: got %q want %q", plan.WorkingDir, bashScript.Directory)
		}
		if plan.Command != "bash" {
			t.Fatalf("expected command 'bash', got %q", plan.Command)
		}
		// Script path should be in the args
		foundScriptPath := false
		for _, arg := range plan.Args {
			if arg == bashScript.AbsolutePath {
				foundScriptPath = true
				break
			}
		}
		if !foundScriptPath {
			t.Fatalf("expected script path in args, got %v", plan.Args)
		}
	})

	t.Run("missing resolver on Windows returns error", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("Windows-specific test")
		}
		t.Parallel()
		_, err := resolveScriptExecutionPlan(bashScript, nil, "windows", func(bin string) (string, error) {
			return "", errors.New("not found")
		})
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}
