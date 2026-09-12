package resources

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestScriptsDir(t *testing.T) {
	got := ScriptsDir("/tmp/devenv-home")
	want := filepath.Join("/tmp/devenv-home", "scripts")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestDiscoverScripts(t *testing.T) {
	t.Parallel()

	t.Run("returns empty when scripts dir does not exist", func(t *testing.T) {
		t.Parallel()
		dir := filepath.Join(t.TempDir(), "scripts")
		scripts, err := DiscoverScripts(dir)
		if err != nil {
			t.Fatalf("DiscoverScripts error = %v", err)
		}
		if len(scripts) != 0 {
			t.Fatalf("expected no scripts, got %d", len(scripts))
		}
	})

	t.Run("discovers executable scripts on Unix, extension+shebang on Windows", func(t *testing.T) {
		t.Parallel()
		root := filepath.Join(t.TempDir(), "scripts")
		if err := os.MkdirAll(filepath.Join(root, "database", "installer"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "packages", "install"), 0755); err != nil {
			t.Fatal(err)
		}

		// Create executable .sh file (with shebang)
		if err := os.WriteFile(filepath.Join(root, "bootstrap.sh"), []byte("#!/usr/bin/env bash\necho hi\n"), 0755); err != nil {
			t.Fatal(err)
		}
		// Create executable Python file
		if err := os.WriteFile(filepath.Join(root, "database", "installer", "migrate.py"), []byte("#!/usr/bin/env python3\nprint('hi')\n"), 0755); err != nil {
			t.Fatal(err)
		}
		// Create non-executable file (should be ignored on Unix)
		if err := os.WriteFile(filepath.Join(root, "packages", "install", "README.md"), []byte("ignored\n"), 0644); err != nil {
			t.Fatal(err)
		}
		// Create executable file without recognized shebang or extension (binary) - should be discovered
		if err := os.WriteFile(filepath.Join(root, "tool"), []byte{0x7f, 0x45, 0x4c, 0x46}, 0755); err != nil {
			t.Fatal(err)
		}

		scripts, err := DiscoverScripts(root)
		if err != nil {
			t.Fatalf("DiscoverScripts error = %v", err)
		}

		byRel := map[string]ScriptFile{}
		for _, s := range scripts {
			byRel[s.RelativePath] = s
		}

		if runtime.GOOS == "windows" {
			// Windows: uses extension-based detection + shebang
			if _, ok := byRel["bootstrap.sh"]; !ok {
				t.Fatalf("expected bootstrap.sh on Windows, got: %+v", scripts)
			}
			// .py is in the extension map, so should be included
			if _, ok := byRel["database/installer/migrate.py"]; !ok {
				t.Fatalf("expected migrate.py on Windows, got: %+v", scripts)
			}
			// README.md not in extension map
			if _, ok := byRel["packages/install/README.md"]; ok {
				t.Fatalf("README.md should not be discovered on Windows")
			}
		} else {
			// Unix: any executable file is a script
			if _, ok := byRel["bootstrap.sh"]; !ok {
				t.Fatalf("expected bootstrap.sh, got: %+v", scripts)
			}
			if _, ok := byRel["database/installer/migrate.py"]; !ok {
				t.Fatalf("expected migrate.py, got: %+v", scripts)
			}
			if _, ok := byRel["tool"]; !ok {
				t.Fatalf("expected executable binary 'tool', got: %+v", scripts)
			}
			// Non-executable file should be excluded
			if _, ok := byRel["packages/install/README.md"]; ok {
				t.Fatalf("README.md should not be discovered (non-executable)")
			}
		}

		// Check interpreter field
		bootstrap, ok := byRel["bootstrap.sh"]
		if !ok {
			return // already reported above
		}
		if bootstrap.Interpreter == "" {
			t.Fatalf("expected interpreter for bootstrap.sh, got empty")
		}
	})

	t.Run("discovers nested scripts in folders", func(t *testing.T) {
		t.Parallel()
		root := filepath.Join(t.TempDir(), "scripts")
		if err := os.MkdirAll(filepath.Join(root, "database", "installer"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "bootstrap.sh"), []byte("#!/usr/bin/env bash\necho hi\n"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "database", "installer", "initialize.sh"), []byte("#!/usr/bin/env bash\necho db\n"), 0755); err != nil {
			t.Fatal(err)
		}

		scripts, err := DiscoverScripts(root)
		if err != nil {
			t.Fatalf("DiscoverScripts error = %v", err)
		}

		byRel := map[string]ScriptFile{}
		for _, s := range scripts {
			byRel[s.RelativePath] = s
		}

		if _, ok := byRel["bootstrap.sh"]; !ok {
			t.Fatalf("missing bootstrap.sh")
		}
		if _, ok := byRel["database/installer/initialize.sh"]; !ok {
			t.Fatalf("missing database/installer/initialize.sh")
		}
	})

	t.Run("detects interpreter from shebang line", func(t *testing.T) {
		t.Parallel()
		root := filepath.Join(t.TempDir(), "scripts")
		if err := os.MkdirAll(root, 0755); err != nil {
			t.Fatal(err)
		}

		// Python script with shebang
		if err := os.WriteFile(filepath.Join(root, "script.py"), []byte("#!/usr/bin/env python3\nprint('hi')\n"), 0755); err != nil {
			t.Fatal(err)
		}
		// Bash script with shebang
		if err := os.WriteFile(filepath.Join(root, "script.sh"), []byte("#!/bin/bash\necho hi\n"), 0755); err != nil {
			t.Fatal(err)
		}
		// TypeScript with bun shebang
		if err := os.WriteFile(filepath.Join(root, "server.ts"), []byte("#!/usr/bin/env bun\nconsole.log('hi')\n"), 0755); err != nil {
			t.Fatal(err)
		}

		scripts, err := DiscoverScripts(root)
		if err != nil {
			t.Fatalf("DiscoverScripts error = %v", err)
		}

		byRel := map[string]ScriptFile{}
		for _, s := range scripts {
			byRel[s.RelativePath] = s
		}

		if runtime.GOOS != "windows" {
			// On Unix, these should all be discovered
			if s, ok := byRel["script.py"]; !ok {
				t.Fatalf("expected script.py, got: %+v", scripts)
			} else if s.Interpreter != "python3" {
				t.Fatalf("expected interpreter 'python3' for script.py, got %q", s.Interpreter)
			}

			if s, ok := byRel["script.sh"]; !ok {
				t.Fatalf("expected script.sh, got: %+v", scripts)
			} else if s.Interpreter != "bash" {
				t.Fatalf("expected interpreter 'bash' for script.sh, got %q", s.Interpreter)
			}

			if s, ok := byRel["server.ts"]; !ok {
				t.Fatalf("expected server.ts, got: %+v", scripts)
			} else if s.Interpreter != "bun" {
				t.Fatalf("expected interpreter 'bun' for server.ts, got %q", s.Interpreter)
			}
		} else {
			// On Windows, .py and .ts are in the extension map
			// .sh is also in the extension map
			if _, ok := byRel["script.sh"]; !ok {
				t.Fatalf("expected script.sh on Windows")
			}
			if _, ok := byRel["script.py"]; !ok {
				t.Fatalf("expected script.py on Windows")
			}
			if _, ok := byRel["server.ts"]; !ok {
				t.Fatalf("expected server.ts on Windows")
			}
		}
	})

	t.Run("non-executable files ignored on Unix", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix-specific test")
		}
		t.Parallel()
		root := filepath.Join(t.TempDir(), "scripts")
		if err := os.MkdirAll(root, 0755); err != nil {
			t.Fatal(err)
		}
		// Non-executable .sh file
		if err := os.WriteFile(filepath.Join(root, "disabled.sh"), []byte("#!/usr/bin/env bash\necho hi\n"), 0644); err != nil {
			t.Fatal(err)
		}
		// Non-executable Python file
		if err := os.WriteFile(filepath.Join(root, "inactive.py"), []byte("#!/usr/bin/env python3\nprint('nope')\n"), 0644); err != nil {
			t.Fatal(err)
		}

		scripts, err := DiscoverScripts(root)
		if err != nil {
			t.Fatalf("DiscoverScripts error = %v", err)
		}
		if len(scripts) != 0 {
			t.Fatalf("expected no scripts for non-executable files, got %d: %+v", len(scripts), scripts)
		}
	})
}

func TestCreateAndLinkScriptFiles(t *testing.T) {
	t.Parallel()

	scriptsRoot := filepath.Join(t.TempDir(), "scripts")
	if err := os.MkdirAll(scriptsRoot, 0755); err != nil {
		t.Fatal(err)
	}

	t.Run("create new script with nested path and default extension", func(t *testing.T) {
		t.Parallel()
		rel, abs, err := CreateScriptFile(scriptsRoot, "ops/db/init", "#!/usr/bin/env bash\necho init\n")
		if err != nil {
			t.Fatalf("CreateScriptFile error = %v", err)
		}
		if rel != "ops/db/init.sh" {
			t.Fatalf("relative path mismatch: got %q", rel)
		}
		if _, err := os.Stat(abs); err != nil {
			t.Fatalf("expected created file at %q: %v", abs, err)
		}
	})

	t.Run("link existing script defaults target extension from source", func(t *testing.T) {
		t.Parallel()
		source := filepath.Join(t.TempDir(), "shared", "deploy.sh")
		if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(source, []byte("#!/usr/bin/env bash\necho deploy\n"), 0755); err != nil {
			t.Fatal(err)
		}

		rel, abs, err := LinkScriptFile(scriptsRoot, "aliases/prod/deploy", source)
		if err != nil {
			t.Fatalf("LinkScriptFile error = %v", err)
		}
		if rel != "aliases/prod/deploy.sh" {
			t.Fatalf("relative path mismatch: got %q", rel)
		}
		linkTarget, err := os.Readlink(abs)
		if err != nil {
			t.Fatalf("expected symlink at %q: %v", abs, err)
		}
		if runtime.GOOS == "windows" {
			if filepath.Clean(linkTarget) != filepath.Clean(source) {
				t.Fatalf("unexpected symlink target: got %q want %q", linkTarget, source)
			}
		} else if linkTarget != source {
			t.Fatalf("unexpected symlink target: got %q want %q", linkTarget, source)
		}
	})

	t.Run("reject path traversal", func(t *testing.T) {
		t.Parallel()
		if _, _, err := CreateScriptFile(scriptsRoot, "../outside", "echo nope\n"); err == nil {
			t.Fatal("expected error for traversal target")
		}
	})

	t.Run("reject missing source script", func(t *testing.T) {
		t.Parallel()
		if _, _, err := LinkScriptFile(scriptsRoot, "alias/missing", filepath.Join(t.TempDir(), "missing.sh")); err == nil {
			t.Fatal("expected error for missing source script")
		}
	})
}

func TestDeleteScriptTarget(t *testing.T) {
	t.Parallel()

	t.Run("deletes existing script file", func(t *testing.T) {
		t.Parallel()
		scriptsRoot := filepath.Join(t.TempDir(), "scripts")
		if err := os.MkdirAll(filepath.Join(scriptsRoot, "ops", "db"), 0755); err != nil {
			t.Fatal(err)
		}

		script := filepath.Join(scriptsRoot, "ops", "db", "cleanup.sh")
		if err := os.WriteFile(script, []byte("#!/usr/bin/env bash\necho cleanup\n"), 0755); err != nil {
			t.Fatal(err)
		}

		rel, abs, err := DeleteScriptTarget(scriptsRoot, "ops/db/cleanup.sh")
		if err != nil {
			t.Fatalf("DeleteScriptTarget error = %v", err)
		}
		if rel != "ops/db/cleanup.sh" {
			t.Fatalf("relative path mismatch: got %q", rel)
		}
		if abs != script {
			t.Fatalf("absolute path mismatch: got %q want %q", abs, script)
		}
		if _, err := os.Stat(script); !os.IsNotExist(err) {
			t.Fatalf("expected script to be deleted, got err=%v", err)
		}
	})

	t.Run("deletes folder recursively", func(t *testing.T) {
		t.Parallel()
		scriptsRoot := filepath.Join(t.TempDir(), "scripts")
		nestedDir := filepath.Join(scriptsRoot, "ops", "db")
		if err := os.MkdirAll(nestedDir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nestedDir, "cleanup.sh"), []byte("echo cleanup\n"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nestedDir, "README.txt"), []byte("note\n"), 0644); err != nil {
			t.Fatal(err)
		}

		rel, abs, err := DeleteScriptTarget(scriptsRoot, "ops")
		if err != nil {
			t.Fatalf("DeleteScriptTarget error = %v", err)
		}
		if rel != "ops" {
			t.Fatalf("relative path mismatch: got %q", rel)
		}
		if abs != filepath.Join(scriptsRoot, "ops") {
			t.Fatalf("absolute path mismatch: got %q", abs)
		}
		if _, err := os.Stat(filepath.Join(scriptsRoot, "ops")); !os.IsNotExist(err) {
			t.Fatalf("expected folder to be deleted, got err=%v", err)
		}
	})

	t.Run("rejects missing target", func(t *testing.T) {
		t.Parallel()
		scriptsRoot := filepath.Join(t.TempDir(), "scripts")
		if _, _, err := DeleteScriptTarget(scriptsRoot, "ops/db/missing.sh"); err == nil {
			t.Fatal("expected error for missing target")
		}
	})

	t.Run("rejects traversal", func(t *testing.T) {
		t.Parallel()
		scriptsRoot := filepath.Join(t.TempDir(), "scripts")
		if _, _, err := DeleteScriptTarget(scriptsRoot, "../outside.sh"); err == nil {
			t.Fatal("expected error for traversal")
		}
	})
}

func TestReadShebang(t *testing.T) {
	t.Parallel()

	t.Run("extracts interpreter from /usr/bin/env shebang", func(t *testing.T) {
		t.Parallel()
		f := filepath.Join(t.TempDir(), "script.sh")
		if err := os.WriteFile(f, []byte("#!/usr/bin/env python3\nprint('hi')\n"), 0644); err != nil {
			t.Fatal(err)
		}
		interp, args, err := readShebang(f)
		if err != nil {
			t.Fatalf("readShebang error = %v", err)
		}
		if interp != "python3" {
			t.Fatalf("expected 'python3', got %q", interp)
		}
		if len(args) != 0 {
			t.Fatalf("expected no args, got %v", args)
		}
	})

	t.Run("extracts interpreter from direct shebang", func(t *testing.T) {
		t.Parallel()
		f := filepath.Join(t.TempDir(), "script.sh")
		if err := os.WriteFile(f, []byte("#!/bin/bash\necho hi\n"), 0644); err != nil {
			t.Fatal(err)
		}
		interp, _, err := readShebang(f)
		if err != nil {
			t.Fatalf("readShebang error = %v", err)
		}
		if interp != "bash" {
			t.Fatalf("expected 'bash', got %q", interp)
		}
	})

	t.Run("returns empty for file without shebang", func(t *testing.T) {
		t.Parallel()
		f := filepath.Join(t.TempDir(), "no-shebang.txt")
		if err := os.WriteFile(f, []byte("just text\n"), 0644); err != nil {
			t.Fatal(err)
		}
		interp, _, err := readShebang(f)
		if err != nil {
			t.Fatalf("readShebang error = %v", err)
		}
		if interp != "" {
			t.Fatalf("expected empty interpreter, got %q", interp)
		}
	})

	t.Run("extracts interpreter with arguments", func(t *testing.T) {
		t.Parallel()
		f := filepath.Join(t.TempDir(), "script.sh")
		if err := os.WriteFile(f, []byte("#!/usr/bin/env python3 -u\nprint('hi')\n"), 0644); err != nil {
			t.Fatal(err)
		}
		interp, args, err := readShebang(f)
		if err != nil {
			t.Fatalf("readShebang error = %v", err)
		}
		if interp != "python3" {
			t.Fatalf("expected 'python3', got %q", interp)
		}
		if len(args) != 1 || args[0] != "-u" {
			t.Fatalf("expected args [\"-u\"], got %v", args)
		}
	})
}

func TestResolveInterpreter(t *testing.T) {
	t.Parallel()

	t.Run("returns empty on non-Windows", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Windows-specific test")
		}
		t.Parallel()
		f := filepath.Join(t.TempDir(), "script.sh")
		if err := os.WriteFile(f, []byte("#!/usr/bin/env bash\necho hi\n"), 0755); err != nil {
			t.Fatal(err)
		}
		cmd, args, err := ResolveInterpreter(f)
		if err != nil {
			t.Fatalf("ResolveInterpreter error = %v", err)
		}
		if cmd != "" || args != nil {
			t.Fatalf("expected (\"\", nil, nil) on non-Windows, got (%q, %v)", cmd, args)
		}
	})

	t.Run("resolves interpreter from shebang on Windows", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("Windows-only test")
		}
		t.Parallel()
		f := filepath.Join(t.TempDir(), "script.py")
		if err := os.WriteFile(f, []byte("#!/usr/bin/env python3\nprint('hi')\n"), 0755); err != nil {
			t.Fatal(err)
		}
		cmd, args, err := ResolveInterpreter(f)
		if err != nil {
			t.Fatalf("ResolveInterpreter error = %v", err)
		}
		if cmd != "python" {
			t.Fatalf("expected 'python', got %q", cmd)
		}
		if len(args) == 0 || args[len(args)-1] != f {
			t.Fatalf("expected script path as last arg, got %v", args)
		}
	})
}
