/*
 * Relocatable Graphify launcher. It runs python\python.exe -m graphify next to
 * itself. ponytail: the install path must fit in 32767 wide characters; a longer
 * path fails closed instead of truncating into a different program.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define PATH_CAP 32768

static void fail(const wchar_t *what) {
  fwprintf(stderr, L"graphify: %ls (winerr=%lu)\n", what, GetLastError());
  ExitProcess(1);
}

static int append_text(wchar_t *out, size_t cap, size_t *used, const wchar_t *text) {
  size_t length = wcslen(text);
  if (*used + length + 1 >= cap) return 0;
  for (size_t i = 0; i < length; i++) out[(*used)++] = text[i];
  out[*used] = L'\0';
  return 1;
}

static int append_quoted(wchar_t *out, size_t cap, size_t *used, const wchar_t *value) {
  if (*used > 0 && !append_text(out, cap, used, L" ")) return 0;
  if (!append_text(out, cap, used, L"\"")) return 0;
  size_t slashes = 0;
  for (size_t i = 0; value[i] != L'\0'; i++) {
    if (value[i] == L'\\') { slashes++; continue; }
    if (value[i] == L'"') {
      for (size_t j = 0; j < slashes * 2 + 1; j++) {
        if (!append_text(out, cap, used, L"\\")) return 0;
      }
      if (!append_text(out, cap, used, L"\"")) return 0;
      slashes = 0;
      continue;
    }
    for (size_t j = 0; j < slashes; j++) {
      if (!append_text(out, cap, used, L"\\")) return 0;
    }
    slashes = 0;
    wchar_t one[2] = { value[i], L'\0' };
    if (!append_text(out, cap, used, one)) return 0;
  }
  for (size_t j = 0; j < slashes * 2; j++) {
    if (!append_text(out, cap, used, L"\\")) return 0;
  }
  return append_text(out, cap, used, L"\"");
}

int wmain(int argc, wchar_t **argv) {
  wchar_t self[PATH_CAP];
  DWORD length = GetModuleFileNameW(NULL, self, PATH_CAP);
  if (length == 0 || length >= PATH_CAP - 1) fail(L"the launcher path is missing or too long");
  wchar_t *slash = wcsrchr(self, L'\\');
  if (!slash) fail(L"the launcher path has no directory");
  wchar_t python[PATH_CAP];
  size_t dirlen = (size_t)(slash - self);
  const wchar_t *tail = L"\\python\\python.exe";
  size_t tailLen = wcslen(tail);
  if (dirlen + tailLen + 1 >= PATH_CAP) fail(L"the bundled Python path is too long");
  for (size_t i = 0; i < dirlen; i++) python[i] = self[i];
  for (size_t i = 0; i < tailLen; i++) python[dirlen + i] = tail[i];
  python[dirlen + tailLen] = L'\0';

  wchar_t command[PATH_CAP];
  size_t used = 0;
  command[0] = L'\0';
  if (!append_quoted(command, PATH_CAP, &used, python)) fail(L"the command line is too long");
  if (!append_quoted(command, PATH_CAP, &used, L"-m")) fail(L"the command line is too long");
  if (!append_quoted(command, PATH_CAP, &used, L"graphify")) fail(L"the command line is too long");
  for (int i = 1; i < argc; i++) {
    if (!append_quoted(command, PATH_CAP, &used, argv[i])) fail(L"the command line is too long");
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(python, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &process)) fail(L"bundled Python failed to start");
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hProcess);
  CloseHandle(process.hThread);
  return (int)code;
}
