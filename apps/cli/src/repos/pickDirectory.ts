import { execFile } from "node:child_process";
import path from "node:path";

const PICK_TIMEOUT_MS = 10 * 60 * 1000;

// FOS_PICKFOLDERS is 0x20. Cancel is HRESULT 0x800704C7 and prints nothing.
const WIN_FOLDER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NemaFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialogRCW {}
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, uint fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  public static string Pick() {
    var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
    dialog.SetOptions(0x20 | 0x40 | 0x800 | 0x8);
    int hr = dialog.Show(IntPtr.Zero);
    if (hr == unchecked((int)0x800704C7)) return "";
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem item;
    dialog.GetResult(out item);
    IntPtr psz;
    item.GetDisplayName(0x80058000, out psz);
    string path = Marshal.PtrToStringUni(psz);
    Marshal.FreeCoTaskMem(psz);
    return path ?? "";
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([NemaFolderDialog]::Pick())
`;

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

export function pickerCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "win32") {
    const encoded = Buffer.from(WIN_FOLDER_SCRIPT, "utf16le").toString("base64");
    return { cmd: "powershell.exe", args: ["-NoProfile", "-STA", "-EncodedCommand", encoded] };
  }
  if (platform === "darwin") return { cmd: "osascript", args: ["-e", "POSIX path of (choose folder)"] };
  return { cmd: "zenity", args: ["--file-selection", "--directory"] };
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** A cancelled dialog is an empty result. Anything that is not one absolute path is refused. */
export function normalizePickedPath(stdout: string, platform: NodeJS.Platform): string | null {
  const picked = stdout.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").trim();
  if (!picked || picked.includes("\0") || /[\r\n]/.test(picked) || picked.length > 4096) return null;
  const api = pathApi(platform);
  if (!api.isAbsolute(picked)) return null;
  const sep = api.sep;
  if (picked.length > 3 && (picked.endsWith(sep) || (platform === "win32" && picked.endsWith("/")))) return picked.slice(0, -1);
  return picked;
}

function isCancel(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 1 && code !== "1") return false;
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return stderr.trim() === "" || /User canceled|-128/.test(stderr);
}

function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        (error as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

let pending: Promise<string | null> | null = null;

/** Opens the OS folder dialog on this machine. A second call shares the dialog already open. */
export function pickDirectory(platform = process.platform, run: CommandRunner = defaultRun): Promise<string | null> {
  if (pending && run === defaultRun) return pending;
  const work = (async () => {
    const { cmd, args } = pickerCommand(platform);
    try {
      const { stdout } = await run(cmd, args, PICK_TIMEOUT_MS);
      return normalizePickedPath(stdout, platform);
    } catch (error) {
      if (isCancel(error)) return null;
      throw new Error("无法打开文件夹选择器");
    }
  })();
  if (run !== defaultRun) return work;
  pending = work.finally(() => {
    pending = null;
  });
  return pending;
}
