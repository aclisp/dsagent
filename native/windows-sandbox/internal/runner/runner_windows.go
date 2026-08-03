//go:build windows

package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const timeoutExitCode = 124

func Run(request Request) (uint32, error) {
	command, cwd, err := validateRequest(request)
	if err != nil {
		return 0, err
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create job object: %w", err)
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		return 0, fmt.Errorf("configure job object: %w", err)
	}

	handles, closeHandles, err := inheritedStandardHandles()
	if err != nil {
		return 0, err
	}
	defer closeHandles()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return 0, fmt.Errorf("create process attribute list: %w", err)
	}
	defer attributes.Delete()
	if err := attributes.Update(
		windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&handles[0]),
		uintptr(len(handles))*unsafe.Sizeof(handles[0]),
	); err != nil {
		return 0, fmt.Errorf("restrict inherited handles: %w", err)
	}

	application, err := windows.UTF16PtrFromString(command)
	if err != nil {
		return 0, fmt.Errorf("encode command: %w", err)
	}
	commandLine, err := windows.UTF16PtrFromString(
		windows.ComposeCommandLine(append([]string{command}, request.Args...)),
	)
	if err != nil {
		return 0, fmt.Errorf("encode command line: %w", err)
	}
	currentDirectory, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return 0, fmt.Errorf("encode working directory: %w", err)
	}
	environment, err := environmentBlock(request.Env)
	if err != nil {
		return 0, err
	}

	startup := windows.StartupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.StdInput = handles[0]
	startup.StdOutput = handles[1]
	startup.StdErr = handles[2]
	startup.ProcThreadAttributeList = attributes.List()
	process := windows.ProcessInformation{}
	flags := uint32(
		windows.CREATE_SUSPENDED |
			windows.CREATE_UNICODE_ENVIRONMENT |
			windows.CREATE_BREAKAWAY_FROM_JOB |
			windows.EXTENDED_STARTUPINFO_PRESENT,
	)
	if err := windows.CreateProcess(
		application,
		commandLine,
		nil,
		nil,
		true,
		flags,
		&environment[0],
		currentDirectory,
		&startup.StartupInfo,
		&process,
	); err != nil {
		return 0, fmt.Errorf("create suspended process: %w", err)
	}
	defer windows.CloseHandle(process.Process)
	defer windows.CloseHandle(process.Thread)

	if err := windows.AssignProcessToJobObject(job, process.Process); err != nil {
		_ = windows.TerminateProcess(process.Process, 125)
		return 0, fmt.Errorf("assign process to job object: %w", err)
	}
	if _, err := windows.ResumeThread(process.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("resume process: %w", err)
	}

	wait := uint32(windows.INFINITE)
	if request.TimeoutMS > 0 {
		wait = request.TimeoutMS
	}
	event, err := windows.WaitForSingleObject(process.Process, wait)
	if err != nil {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("wait for process: %w", err)
	}
	if event == uint32(windows.WAIT_TIMEOUT) {
		_ = windows.TerminateJobObject(job, timeoutExitCode)
		_, _ = windows.WaitForSingleObject(process.Process, windows.INFINITE)
		return timeoutExitCode, nil
	}
	if event != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("unexpected process wait result: %d", event)
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return 0, fmt.Errorf("read process exit code: %w", err)
	}
	return exitCode, nil
}

func validateRequest(request Request) (string, string, error) {
	if request.Version != ProtocolVersion {
		return "", "", fmt.Errorf("unsupported protocol version: %d", request.Version)
	}
	if strings.TrimSpace(request.Command) == "" {
		return "", "", fmt.Errorf("command is required")
	}
	command, err := exec.LookPath(request.Command)
	if err != nil {
		return "", "", fmt.Errorf("resolve command %q: %w", request.Command, err)
	}
	command, err = filepath.Abs(command)
	if err != nil {
		return "", "", fmt.Errorf("resolve command path: %w", err)
	}
	cwd, err := filepath.Abs(request.Cwd)
	if err != nil {
		return "", "", fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return "", "", fmt.Errorf("inspect working directory: %w", err)
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("working directory is not a directory: %s", cwd)
	}
	return command, cwd, nil
}

func inheritedStandardHandles() ([3]windows.Handle, func(), error) {
	standard := []uint32{windows.STD_INPUT_HANDLE, windows.STD_OUTPUT_HANDLE, windows.STD_ERROR_HANDLE}
	var handles [3]windows.Handle
	for index, kind := range standard {
		source, err := windows.GetStdHandle(kind)
		if err != nil {
			closeWindowsHandles(handles[:index])
			return handles, func() {}, fmt.Errorf("get standard handle: %w", err)
		}
		if err := windows.DuplicateHandle(
			windows.CurrentProcess(),
			source,
			windows.CurrentProcess(),
			&handles[index],
			0,
			true,
			windows.DUPLICATE_SAME_ACCESS,
		); err != nil {
			closeWindowsHandles(handles[:index])
			return handles, func() {}, fmt.Errorf("duplicate standard handle: %w", err)
		}
	}
	return handles, func() { closeWindowsHandles(handles[:]) }, nil
}

func closeWindowsHandles(handles []windows.Handle) {
	for _, handle := range handles {
		if handle != 0 && handle != windows.InvalidHandle {
			_ = windows.CloseHandle(handle)
		}
	}
}

func environmentBlock(overrides map[string]string) ([]uint16, error) {
	values := make(map[string]string, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			values[strings.ToUpper(key)] = entry
		}
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("invalid environment entry: %q", key)
		}
		values[strings.ToUpper(key)] = key + "=" + value
	}
	entries := make([]string, 0, len(values))
	for _, entry := range values {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToUpper(entries[i]) < strings.ToUpper(entries[j])
	})
	block := strings.Join(entries, "\x00") + "\x00\x00"
	return utf16.Encode([]rune(block)), nil
}
