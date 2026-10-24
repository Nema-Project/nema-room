#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/*
 * A guardian is one managed helper's sole Job Object owner. The parent holds
 * the named-pipe client end as a lease; stdin remains application data.
 * argv: owned-helper.exe <pipe> <quoted|verbatim> <target> [target arguments...]
 */
static void fail(const wchar_t *what) {
  fwprintf(stderr, L"owned-helper: %ls (winerr=%lu)\n", what, GetLastError());
  ExitProcess(120);
}

static wchar_t *quote_arg(const wchar_t *value) {
  size_t length = wcslen(value);
  if (length > 0 && wcspbrk(value, L" \t\"") == NULL) return _wcsdup(value);
  size_t capacity = length * 2 + 3;
  size_t used = 0;
  size_t slashes = 0;
  wchar_t *quoted = (wchar_t *)calloc(capacity, sizeof(wchar_t));
  if (!quoted) return NULL;
  quoted[used++] = L'"';
  for (size_t i = 0; i < length; i++) {
    if (value[i] == L'\\') { slashes++; continue; }
    if (value[i] == L'"') {
      for (size_t j = 0; j < slashes * 2 + 1; j++) quoted[used++] = L'\\';
      quoted[used++] = L'"';
      slashes = 0;
      continue;
    }
    for (size_t j = 0; j < slashes; j++) quoted[used++] = L'\\';
    slashes = 0;
    quoted[used++] = value[i];
  }
  for (size_t j = 0; j < slashes * 2; j++) quoted[used++] = L'\\';
  quoted[used++] = L'"';
  quoted[used] = L'\0';
  return quoted;
}

static wchar_t *make_command_line(int argc, wchar_t **argv, BOOL verbatim) {
  const size_t capacity = 32768;
  size_t used = 0;
  wchar_t *line = (wchar_t *)calloc(capacity, sizeof(wchar_t));
  if (!line) return NULL;
  for (int i = 3; i < argc; i++) {
    wchar_t *part = (verbatim && i > 3) ? _wcsdup(argv[i]) : quote_arg(argv[i]);
    if (!part) { free(line); return NULL; }
    size_t length = wcslen(part);
    if (used + length + 2 >= capacity) { free(part); free(line); return NULL; }
    if (i > 3) line[used++] = L' ';
    memcpy(line + used, part, length * sizeof(wchar_t));
    used += length;
    free(part);
  }
  return line;
}

static BOOL private_pipe_security(SECURITY_ATTRIBUTES *attributes, PSECURITY_DESCRIPTOR *descriptor) {
  HANDLE token = NULL;
  DWORD required = 0;
  TOKEN_USER *user = NULL;
  LPWSTR sid = NULL;
  BOOL ok = FALSE;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
  GetTokenInformation(token, TokenUser, NULL, 0, &required);
  user = (TOKEN_USER *)malloc(required);
  if (!user || !GetTokenInformation(token, TokenUser, user, required, &required)) goto done;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) goto done;
  wchar_t sddl[256];
  if (swprintf(sddl, 256, L"D:P(A;;GA;;;%ls)", sid) < 0) goto done;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, NULL)) goto done;
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = *descriptor;
  attributes->bInheritHandle = FALSE;
  ok = TRUE;
done:
  if (sid) LocalFree(sid);
  if (user) free(user);
  if (token) CloseHandle(token);
  return ok;
}

static void cancel_and_wait(HANDLE handle, OVERLAPPED *operation) {
  DWORD transferred = 0;
  CancelIoEx(handle, operation);
  /* CancelIoEx only requests cancellation; the OVERLAPPED must outlive completion. */
  GetOverlappedResult(handle, operation, &transferred, TRUE);
}

static BOOL read_exact(HANDLE pipe, char *buffer, DWORD length, DWORD timeout_ms) {
  OVERLAPPED operation = {0};
  DWORD transferred = 0;
  BOOL ok;
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!operation.hEvent) return FALSE;
  ok = ReadFile(pipe, buffer, length, &transferred, &operation);
  if (!ok && GetLastError() == ERROR_IO_PENDING) {
    DWORD wait = WaitForSingleObject(operation.hEvent, timeout_ms);
    if (wait == WAIT_OBJECT_0) ok = GetOverlappedResult(pipe, &operation, &transferred, FALSE);
    else { cancel_and_wait(pipe, &operation); ok = FALSE; }
  }
  CloseHandle(operation.hEvent);
  return ok && transferred == length;
}

static BOOL write_exact(HANDLE pipe, const char *buffer, DWORD length) {
  OVERLAPPED operation = {0};
  DWORD transferred = 0;
  BOOL ok;
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!operation.hEvent) return FALSE;
  ok = WriteFile(pipe, buffer, length, &transferred, &operation);
  if (!ok && GetLastError() == ERROR_IO_PENDING) {
    DWORD wait = WaitForSingleObject(operation.hEvent, 5000);
    if (wait == WAIT_OBJECT_0) ok = GetOverlappedResult(pipe, &operation, &transferred, FALSE);
    else { cancel_and_wait(pipe, &operation); ok = FALSE; }
  }
  CloseHandle(operation.hEvent);
  return ok && transferred == length;
}

static BOOL send_status(HANDLE pipe, char tag, DWORD code) {
  char message[5] = { tag, (char)(code & 255), (char)((code >> 8) & 255), (char)((code >> 16) & 255), (char)((code >> 24) & 255) };
  return write_exact(pipe, message, sizeof(message));
}

static BOOL wait_for_job_empty(HANDLE job, DWORD timeout_ms) {
  DWORD elapsed = 0;
  while (elapsed <= timeout_ms) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) return FALSE;
    if (accounting.ActiveProcesses == 0) return TRUE;
    Sleep(10);
    elapsed += 10;
  }
  return FALSE;
}

#ifdef NEMA_GUARDIAN_TESTING
static void test_delay(const wchar_t *variable) {
  wchar_t value[16] = {0};
  DWORD length = GetEnvironmentVariableW(variable, value, 16);
  if (length > 0 && length < 16) Sleep((DWORD)_wtoi(value));
}
#endif

static DWORD WINAPI lease_watcher(LPVOID value) {
  HANDLE pipe = (HANDLE)value;
  char byte;
  return read_exact(pipe, &byte, 1, INFINITE) ? 0 : 1;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 4 || (wcscmp(argv[2], L"quoted") != 0 && wcscmp(argv[2], L"verbatim") != 0)) {
    fwprintf(stderr, L"owned-helper: invalid arguments\n");
    return 121;
  }

#ifdef NEMA_GUARDIAN_TESTING
  test_delay(L"NEMA_TEST_DELAY_CREATE_PIPE_MS");
#endif

  SECURITY_ATTRIBUTES pipe_attributes = {0};
  PSECURITY_DESCRIPTOR pipe_descriptor = NULL;
  if (!private_pipe_security(&pipe_attributes, &pipe_descriptor)) fail(L"creating current-user pipe ACL");
  HANDLE pipe = CreateNamedPipeW(argv[1], PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1, 64, 64, 0, &pipe_attributes);
  LocalFree(pipe_descriptor);
  if (pipe == INVALID_HANDLE_VALUE) fail(L"CreateNamedPipeW");

  OVERLAPPED connection = {0};
  connection.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!connection.hEvent) fail(L"CreateEventW for pipe connection");
  BOOL connected = ConnectNamedPipe(pipe, &connection);
  if (!connected && GetLastError() == ERROR_IO_PENDING) {
    DWORD wait = WaitForSingleObject(connection.hEvent, 5000);
    if (wait != WAIT_OBJECT_0) {
      cancel_and_wait(pipe, &connection);
      CloseHandle(connection.hEvent);
      CloseHandle(pipe);
      return 122;
    }
    DWORD transferred = 0;
    if (!GetOverlappedResult(pipe, &connection, &transferred, FALSE) && GetLastError() != ERROR_PIPE_CONNECTED) fail(L"ConnectNamedPipe completion");
  } else if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) fail(L"ConnectNamedPipe");
  CloseHandle(connection.hEvent);

  char lease[5] = {0};
  if (!read_exact(pipe, lease, sizeof(lease), 5000) || memcmp(lease, "LEASE", sizeof(lease)) != 0) {
    CloseHandle(pipe);
    return 123;
  }

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) { DWORD error = GetLastError(); send_status(pipe, 'E', error); CloseHandle(pipe); return 124; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    DWORD error = GetLastError(); send_status(pipe, 'E', error); CloseHandle(job); CloseHandle(pipe); return 124;
  }

  wchar_t *command_line = make_command_line(argc, argv, wcscmp(argv[2], L"verbatim") == 0);
  if (!command_line) { DWORD error = ERROR_NOT_ENOUGH_MEMORY; send_status(pipe, 'E', error); CloseHandle(job); CloseHandle(pipe); return 124; }
  STARTUPINFOEXW startup = {0};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  HANDLE inherited_standard_handles[3] = { startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError };
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_bytes);
  startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited_standard_handles, sizeof(inherited_standard_handles), NULL, NULL)) fail(L"setting standard-handle whitelist");

  PROCESS_INFORMATION process = {0};
  /* Passing a bare lpApplicationName skips the PATH search used by Node spawn().
   * The mutable command line already starts with the correctly quoted target. */
  BOOL created = CreateProcessW(NULL, command_line, NULL, NULL, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
    NULL, NULL, &startup.StartupInfo, &process);
  DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  free(command_line);
  if (!created) {
    DWORD error = create_error;
    send_status(pipe, 'E', error);
    CloseHandle(job);
    CloseHandle(pipe);
    return 127;
  }

#ifdef NEMA_GUARDIAN_TESTING
  if (GetEnvironmentVariableW(L"NEMA_TEST_ASSIGN_FAIL", NULL, 0) > 0) CloseHandle(job);
#endif

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    DWORD error = GetLastError();
    TerminateProcess(process.hProcess, 126);
    WaitForSingleObject(process.hProcess, 3000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    send_status(pipe, 'E', error);
    CloseHandle(pipe);
    return 126;
  }

#ifdef NEMA_GUARDIAN_TESTING
  test_delay(L"NEMA_TEST_DELAY_BEFORE_RESUME_MS");
#endif
  if (ResumeThread(process.hThread) == (DWORD)-1) {
    DWORD error = GetLastError();
    TerminateJobObject(job, 125);
    WaitForSingleObject(process.hProcess, 3000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    send_status(pipe, 'E', error);
    CloseHandle(pipe);
    return 125;
  }
  if (!send_status(pipe, 'R', 0)) {
    TerminateJobObject(job, 125);
    wait_for_job_empty(job, 5000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    CloseHandle(pipe);
    return 125;
  }

  CloseHandle(process.hThread);
  HANDLE watcher = CreateThread(NULL, 0, lease_watcher, pipe, 0, NULL);
  if (!watcher) { TerminateJobObject(job, 125); wait_for_job_empty(job, 5000); fail(L"creating lease watcher"); }
  HANDLE waits[2] = { process.hProcess, watcher };
  DWORD wait = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  DWORD exit_code = 124;
  if (wait == WAIT_OBJECT_0) {
    GetExitCodeProcess(process.hProcess, &exit_code);
    TerminateJobObject(job, exit_code);
  } else {
    TerminateJobObject(job, 124);
  }
  wait_for_job_empty(job, 5000);
  CloseHandle(job);
  CloseHandle(watcher);
  CloseHandle(pipe);
  CloseHandle(process.hProcess);
  return (int)exit_code;
}
