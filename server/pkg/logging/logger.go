package logging

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Logger captures runtime command output. Operational history uses action runs.
type Logger interface {
	// RunCommandWithLogging executes a command and logs the result.
	RunCommandWithLogging(appIdent, command string, args []string, envVars []string, workingDir string) (error, string)
	// RunCommandWithLoggingToFile executes a command and streams stdout/stderr to logPath.
	RunCommandWithLoggingToFile(appIdent, command string, args []string, envVars []string, workingDir string, logPath string) (error, string)
	RunCommandWithActionLoggingToFile(ctx context.Context, appIdent, command string, args []string, envVars []string, workingDir, logPath string, output func(stream, chunk string)) (error, string)
}

// fileLogger implements the Logger interface
type fileLogger struct {
	homeDir string
}

// NewLogger creates a new file-based logger.
// homeDir is the devenv home directory (e.g. ~/devenv).
func NewLogger(homeDir string) (Logger, error) {
	if homeDir == "" {
		return nil, fmt.Errorf("homeDir is required")
	}

	logDir := filepath.Join(homeDir, "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create log directory: %w", err)
	}

	return &fileLogger{homeDir: homeDir}, nil
}

func (l *fileLogger) RunCommandWithLogging(appIdent, command string, args []string, envVars []string, workingDir string) (error, string) {
	return l.RunCommandWithLoggingToFile(appIdent, command, args, envVars, workingDir, "")
}

func (l *fileLogger) RunCommandWithLoggingToFile(appIdent, command string, args []string, envVars []string, workingDir string, logPath string) (error, string) {
	cmd := exec.Command(command, args...)
	cmd.Env = append(os.Environ(), envVars...)
	cmd.Dir = workingDir

	logFiles, closeLog := l.openCommandLogs(appIdent, command, args, envVars, workingDir, logPath)
	defer closeLog()

	var output bytes.Buffer
	writer := &lockedMultiWriter{mu: &sync.Mutex{}, writers: []io.Writer{&output}}
	for _, logFile := range logFiles {
		writer.writers = append(writer.writers, logFile)
	}
	cmd.Stdout = writer
	cmd.Stderr = writer

	err := cmd.Run()
	out := output.String()
	if len(logFiles) > 0 {
		timestamp := time.Now().Format("2006-01-02 15:04:05")
		for _, logFile := range logFiles {
			if err != nil {
				_, _ = fmt.Fprintf(logFile, "\n[%s] Exit: ERROR (%s)\n", timestamp, err.Error())
			} else {
				_, _ = fmt.Fprintf(logFile, "\n[%s] Exit: SUCCESS\n", timestamp)
			}
			_, _ = fmt.Fprintf(logFile, "[%s] ---\n\n", timestamp)
		}
	}

	return err, out
}

func (l *fileLogger) RunCommandWithActionLoggingToFile(ctx context.Context, appIdent, command string, args []string, envVars []string, workingDir, logPath string, output func(stream, chunk string)) (error, string) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = append(os.Environ(), envVars...)
	cmd.Dir = workingDir
	logFiles, closeLog := l.openCommandLogs(appIdent, command, args, envVars, workingDir, logPath)
	defer closeLog()
	var combined bytes.Buffer
	var outputMu sync.Mutex
	makeWriter := func(stream string) io.Writer {
		return &lockedMultiWriter{
			mu:      &outputMu,
			writers: []io.Writer{&combined, chunkWriter{stream: stream, callback: output}, logWriter{files: logFiles}},
		}
	}
	cmd.Stdout = makeWriter("stdout")
	cmd.Stderr = makeWriter("stderr")
	err := cmd.Run()
	out := combined.String()
	return err, out
}

type chunkWriter struct {
	stream   string
	callback func(string, string)
}

func (w chunkWriter) Write(p []byte) (int, error) {
	if w.callback != nil {
		w.callback(w.stream, string(p))
	}
	return len(p), nil
}

type logWriter struct{ files []*os.File }

func (w logWriter) Write(p []byte) (int, error) {
	for _, f := range w.files {
		if _, err := f.Write(p); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

type lockedMultiWriter struct {
	mu      *sync.Mutex
	writers []io.Writer
}

func (w *lockedMultiWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, writer := range w.writers {
		if _, err := writer.Write(p); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (l *fileLogger) openCommandLogs(appIdent, command string, args []string, envVars []string, workingDir string, logPath string) ([]*os.File, func()) {
	var files []*os.File
	if logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), 0755); err == nil {
			if logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
				l.writeCommandHeader(logFile, command, args, envVars, workingDir)
				files = append(files, logFile)
			}
		}
	}
	if appLog, closeAppLog := l.openIndividualAppLog(appIdent, command, args, envVars, workingDir); appLog != nil {
		_ = closeAppLog
		files = append(files, appLog)
	}
	return files, func() {
		for _, file := range files {
			_ = file.Close()
		}
	}
}

func (l *fileLogger) openIndividualAppLog(appIdent, command string, args []string, envVars []string, workingDir string) (*os.File, func()) {
	logDir := filepath.Join(l.homeDir, "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, func() {}
	}
	logFilePath := filepath.Join(logDir, appIdent+".log")
	logFile, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, func() {}
	}
	l.writeCommandHeader(logFile, command, args, envVars, workingDir)
	return logFile, func() { _ = logFile.Close() }
}

func (l *fileLogger) writeCommandHeader(logFile *os.File, command string, args []string, envVars []string, workingDir string) {
	timestamp := time.Now().Format("2006-01-02 15:04:05")
	_, _ = fmt.Fprintf(logFile, "[%s] Command: %s\n", timestamp, shellQuoteCommand(command, args))
	if workingDir != "" {
		_, _ = fmt.Fprintf(logFile, "[%s] Working directory: %s\n", timestamp, workingDir)
	}
	if len(envVars) > 0 {
		_, _ = fmt.Fprintf(logFile, "[%s] Environment overrides: %s\n", timestamp, strings.Join(envVars, " "))
	}
	_, _ = fmt.Fprintf(logFile, "[%s] Output:\n", timestamp)
}

func shellQuoteCommand(command string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, strconv.Quote(command))
	for _, arg := range args {
		parts = append(parts, strconv.Quote(arg))
	}
	return strings.Join(parts, " ")
}
