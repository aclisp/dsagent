//go:build windows

package runner

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunPreservesExitCodeAndEnvironment(t *testing.T) {
	t.Parallel()
	exitCode, err := Run(Request{
		Version: ProtocolVersion,
		Command: "powershell.exe",
		Args: []string{
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"if ($env:DSCODE_RUNNER_TEST -ne 'AB-中文-CD') { exit 9 }; exit 7",
		},
		Cwd: t.TempDir(),
		Env: map[string]string{"DSCODE_RUNNER_TEST": "AB-中文-CD"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != 7 {
		t.Fatalf("exit code = %d, want 7", exitCode)
	}
}

func TestRunTimeoutKillsDescendants(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "survived.txt")
	script := "$child = Start-Process powershell.exe -PassThru -ArgumentList @(" +
		"'-NoProfile','-NonInteractive','-Command'," +
		"'Start-Sleep -Milliseconds 1200; Set-Content -LiteralPath ''" +
		powershellLiteral(marker) + "'' -Value survived'); " +
		"Start-Sleep -Seconds 30"
	exitCode, err := Run(Request{
		Version:   ProtocolVersion,
		Command:   "powershell.exe",
		Args:      []string{"-NoProfile", "-NonInteractive", "-Command", script},
		Cwd:       root,
		TimeoutMS: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != timeoutExitCode {
		t.Fatalf("exit code = %d, want %d", exitCode, timeoutExitCode)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("descendant survived job termination: %v", err)
	}
}

func powershellLiteral(value string) string {
	result := ""
	for _, character := range value {
		if character == '\'' {
			result += "''"
		} else {
			result += string(character)
		}
	}
	return result
}
