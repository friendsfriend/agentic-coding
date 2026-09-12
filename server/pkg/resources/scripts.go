package resources

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type ScriptParameterType string

const (
	ScriptParamString ScriptParameterType = "string"
	ScriptParamInt    ScriptParameterType = "int"
	ScriptParamBool   ScriptParameterType = "bool"
	ScriptParamEnum   ScriptParameterType = "enum"
)

type ScriptParameter struct {
	Name         string              `json:"name"`
	Type         ScriptParameterType `json:"type"`
	Required     bool                `json:"required"`
	Description  string              `json:"description,omitempty"`
	DefaultValue string              `json:"defaultValue,omitempty"`
	Choices      []string            `json:"choices,omitempty"`
	Flag         string              `json:"flag,omitempty"`
}

// ScriptFile represents a discovered script under the devenv home directory.
type ScriptFile struct {
	Name         string            `json:"name"`
	RelativePath string            `json:"relativePath"`
	AbsolutePath string            `json:"absolutePath"`
	Directory    string            `json:"directory"`
	Extension    string            `json:"extension"`
	Interpreter  string            `json:"interpreter,omitempty"`
	Parameters   []ScriptParameter `json:"parameters,omitempty"`
}

// ScriptsDir returns the canonical scripts directory under the devenv home directory.
func ScriptsDir(homeDir string) string {
	return filepath.Join(homeDir, "scripts")
}

// isExecutable reports whether the file mode has at least one executable bit set
// (owner, group, or other). Used for Unix discovery.
func isExecutable(mode fs.FileMode) bool {
	return mode&0111 != 0
}

// DiscoverScripts recursively scans scriptsDir and returns all supported scripts.
// On Unix, a file is a script if it is executable (+x) and not a directory.
// On Windows, discovery uses shebang detection + extension-based fallback.
func DiscoverScripts(scriptsDir string) ([]ScriptFile, error) {
	if strings.TrimSpace(scriptsDir) == "" {
		return nil, nil
	}

	if _, err := os.Stat(scriptsDir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	winExtMap := windowsExtInterpreterMap()

	result := make([]ScriptFile, 0)
	err := filepath.WalkDir(scriptsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		if runtime.GOOS == "windows" {
			ext := strings.ToLower(filepath.Ext(d.Name()))
			if _, ok := winExtMap[ext]; ok {
				// recognized extension — include it
			} else {
				// check if file has a shebang with recognized interpreter
				interp, _, err := readShebang(path)
				if err != nil || !isRecognizedInterpreter(interp) {
					return nil
				}
			}
		} else {
			// Unix: check executable bit
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !isExecutable(info.Mode()) {
				return nil
			}
		}

		rel, relErr := filepath.Rel(scriptsDir, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		ext := strings.ToLower(filepath.Ext(d.Name()))

		interpreter := readInterpreterFromShebang(path, ext)

		result = append(result, ScriptFile{
			Name:         d.Name(),
			RelativePath: rel,
			AbsolutePath: path,
			Directory:    filepath.Dir(path),
			Extension:    ext,
			Interpreter:  interpreter,
			Parameters:   nil, // parameters are fetched via metadata endpoint
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].RelativePath < result[j].RelativePath
	})

	return result, nil
}

// readShebang reads the first line of a file and extracts the interpreter name
// from a shebang (#!) line. On success it returns the interpreter name and any
// leading arguments (e.g. "#!/usr/bin/env python3 -u" → "python3", ["-u"]).
func readShebang(filePath string) (interpreter string, args []string, err error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", nil, err
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	line, err := reader.ReadString('\n')
	if err != nil && len(line) == 0 {
		return "", nil, fmt.Errorf("cannot read shebang: %w", err)
	}

	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "#!") {
		return "", nil, nil // no shebang
	}

	// Strip the #! prefix and parse
	rest := strings.TrimSpace(line[2:])
	if rest == "" {
		return "", nil, nil
	}

	parts := strings.Fields(rest)
	if len(parts) == 0 {
		return "", nil, nil
	}

	// Extract the base interpreter name from the path
	interpPath := parts[0]
	interp := filepath.Base(interpPath)

	// Handle /usr/bin/env → the next argument is the actual interpreter
	if interp == "env" && len(parts) > 1 {
		interp = parts[1]
		args = parts[2:]
	} else {
		args = parts[1:]
	}

	return interp, args, nil
}

// readInterpreterFromShebang reads the shebang of a file and returns the
// interpreter name. It falls back to extension-based guessing if no shebang
// is found.
func readInterpreterFromShebang(filePath string, ext string) string {
	interp, _, err := readShebang(filePath)
	if err != nil || interp == "" {
		// fallback: map known extensions to interpreter names
		switch strings.ToLower(ext) {
		case ".sh":
			return "bash"
		case ".ps1":
			return "pwsh"
		case ".py":
			return "python"
		case ".ts", ".js", ".mjs", ".cjs":
			return "bun"
		case ".rs":
			return "rust-script"
		default:
			return ""
		}
	}
	return interp
}

// isRecognizedInterpreter checks whether an interpreter name corresponds to
// a known/expected runtime. Used on Windows to decide whether to include a
// shebang-only (no extension) file.
var recognizedInterpreters = map[string]bool{
	"bash":        true,
	"sh":          true,
	"zsh":         true,
	"python":      true,
	"python3":     true,
	"python3.11":  true,
	"python3.12":  true,
	"pwsh":        true,
	"powershell":  true,
	"bun":         true,
	"node":        true,
	"deno":        true,
	"ruby":        true,
	"perl":        true,
	"lua":         true,
	"R":           true,
	"julia":       true,
	"nu":          true,
	"nu_scripts":  true,
	"nushell":     true,
	"rust-script": true,
	"dotnet":      true,
}

func isRecognizedInterpreter(name string) bool {
	return recognizedInterpreterAlias(name)
}

func recognizedInterpreterAlias(interp string) bool {
	// Normalize: strip common prefixes
	base := strings.TrimSuffix(strings.TrimSuffix(interp, ".exe"), ".EXE")
	if _, ok := recognizedInterpreters[base]; ok {
		return true
	}
	return false
}

// windowsExtInterpreterMap returns a map of file extensions to interpreter names
// used for Windows script discovery.
func windowsExtInterpreterMap() map[string]string {
	return map[string]string{
		".sh":  "bash",
		".ps1": "pwsh",
		".py":  "python",
		".ts":  "bun",
		".js":  "bun",
		".exe": "",
		".bat": "",
		".cmd": "",
	}
}

// resolveInterpreter returns the command and arguments needed to run a script
// file. On Unix it returns ("", nil, nil) to signal direct execution via the
// kernel's shebang handler. On Windows it reads the shebang line to determine
// the interpreter, falling back to an extension-based mapping.
func ResolveInterpreter(scriptPath string) (cmd string, args []string, err error) {
	if runtime.GOOS != "windows" {
		// Unix: direct execution via shebang
		return "", nil, nil
	}

	// Windows: read shebang
	interp, shebangArgs, err := readShebang(scriptPath)
	if err != nil || interp == "" {
		// Fall back to extension-based mapping
		ext := strings.ToLower(filepath.Ext(scriptPath))
		mapped, ok := windowsExtInterpreterMap()[ext]
		if !ok || mapped == "" {
			return "", nil, fmt.Errorf("no interpreter found for %s", scriptPath)
		}
		return mapped, []string{scriptPath}, nil
	}

	// Map common Unix interpreter names to Windows commands
	interp = mapShebangToWindows(interp)
	return interp, append(shebangArgs, scriptPath), nil
}

// mapShebangToWindows maps Unix-style interpreter names to Windows executables.
func mapShebangToWindows(interp string) string {
	base := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(interp, ".exe"), ".EXE"))
	switch base {
	case "bash":
		return "bash"
	case "sh":
		return "sh"
	case "zsh":
		return "zsh"
	case "python", "python3":
		return "python"
	case "pwsh", "powershell":
		return "pwsh"
	case "bun":
		return "bun"
	case "node":
		return "node"
	case "deno":
		return "deno"
	case "ruby":
		return "ruby"
	case "perl":
		return "perl"
	default:
		return interp
	}
}

// ResolveScriptTargetPath validates and resolves a user-provided script target name/path
// (e.g. "folder/subfolder/script" or "script") under scriptsDir.
// If no extension is provided, defaultExtension is appended.
func ResolveScriptTargetPath(scriptsDir, targetPath, defaultExtension string) (relativePath string, absolutePath string, err error) {
	if strings.TrimSpace(scriptsDir) == "" {
		return "", "", fmt.Errorf("scripts directory is not configured")
	}

	raw := strings.TrimSpace(strings.ReplaceAll(targetPath, "\\", "/"))
	if raw == "" {
		return "", "", fmt.Errorf("target name/path is required")
	}
	if strings.HasPrefix(raw, "/") || filepath.IsAbs(raw) {
		return "", "", fmt.Errorf("target name/path must be relative to scripts/")
	}

	clean := path.Clean(raw)
	if clean == "." || clean == "" {
		return "", "", fmt.Errorf("target name/path is invalid")
	}
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", "", fmt.Errorf("target name/path cannot escape scripts/")
	}

	if ext := strings.ToLower(path.Ext(clean)); ext == "" && strings.TrimSpace(defaultExtension) != "" {
		if strings.HasPrefix(defaultExtension, ".") {
			clean += defaultExtension
		} else {
			clean += "." + defaultExtension
		}
	}

	abs := filepath.Join(scriptsDir, filepath.FromSlash(clean))
	relToRoot, relErr := filepath.Rel(scriptsDir, abs)
	if relErr != nil {
		return "", "", relErr
	}
	relToRoot = filepath.ToSlash(relToRoot)
	if relToRoot == ".." || strings.HasPrefix(relToRoot, "../") {
		return "", "", fmt.Errorf("target name/path cannot escape scripts/")
	}

	return clean, abs, nil
}

func ValidateExistingScriptPath(sourcePath string) (absolutePath string, extension string, err error) {
	raw := strings.TrimSpace(sourcePath)
	if raw == "" {
		return "", "", fmt.Errorf("source script path is required")
	}

	abs, absErr := filepath.Abs(raw)
	if absErr != nil {
		return "", "", absErr
	}
	stat, statErr := os.Stat(abs)
	if statErr != nil {
		if errors.Is(statErr, fs.ErrNotExist) {
			return "", "", fmt.Errorf("source script path does not exist")
		}
		return "", "", statErr
	}
	if stat.IsDir() {
		return "", "", fmt.Errorf("source script path must be a file")
	}

	ext := strings.ToLower(filepath.Ext(abs))
	// Accept any script file type (not just .sh/.ps1)
	if ext == "" {
		return "", "", fmt.Errorf("source script must have an extension")
	}

	return abs, ext, nil
}

func ensureTargetDoesNotExist(targetPath string) error {
	if _, err := os.Lstat(targetPath); err == nil {
		return fmt.Errorf("target script already exists")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func CreateScriptFile(scriptsDir, targetPath, content string) (relativePath string, absolutePath string, err error) {
	rel, abs, err := ResolveScriptTargetPath(scriptsDir, targetPath, ".sh")
	if err != nil {
		return "", "", err
	}
	if err := ensureTargetDoesNotExist(abs); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(abs, []byte(content), 0755); err != nil {
		return "", "", err
	}
	return rel, abs, nil
}

func LinkScriptFile(scriptsDir, targetPath, sourcePath string) (relativePath string, absolutePath string, err error) {
	sourceAbs, sourceExt, err := ValidateExistingScriptPath(sourcePath)
	if err != nil {
		return "", "", err
	}
	rel, abs, err := ResolveScriptTargetPath(scriptsDir, targetPath, sourceExt)
	if err != nil {
		return "", "", err
	}
	if err := ensureTargetDoesNotExist(abs); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return "", "", err
	}
	if err := os.Symlink(sourceAbs, abs); err != nil {
		return "", "", err
	}
	return rel, abs, nil
}

func DeleteScriptTarget(scriptsDir, relativePath string) (resolvedRelativePath string, absolutePath string, err error) {
	rel, abs, err := ResolveScriptTargetPath(scriptsDir, relativePath, "")
	if err != nil {
		return "", "", err
	}

	stat, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", "", fmt.Errorf("script target does not exist")
		}
		return "", "", err
	}

	if stat.IsDir() {
		if err := os.RemoveAll(abs); err != nil {
			return "", "", err
		}
		return rel, abs, nil
	}

	// Allow deleting any script target (not just .sh/.ps1)
	if err := os.Remove(abs); err != nil {
		return "", "", err
	}

	return rel, abs, nil
}
