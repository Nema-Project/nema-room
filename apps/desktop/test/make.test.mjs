import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builderConfig, parseMakeArgs, validateElectronNotices } from '../../../scripts/desktop/make.mjs';
import { parseSmokeArgs } from '../../../scripts/desktop/smoke-desktop.mjs';

describe('native Electron packaging configuration', () => {
  it('accepts only native Windows x64 and macOS arm64 builds', () => {
    expect(parseMakeArgs(['--platform', 'win32', '--arch', 'x64'], { platform: 'win32', arch: 'x64' })).toMatchObject({ platform: 'win32', arch: 'x64' });
    expect(parseMakeArgs(['--platform', 'darwin', '--arch', 'arm64'], { platform: 'darwin', arch: 'arm64' })).toMatchObject({ platform: 'darwin', arch: 'arm64' });
    expect(() => parseMakeArgs(['--platform', 'darwin', '--arch', 'arm64'], { platform: 'win32', arch: 'x64' })).toThrow(/native/i);
    expect(() => parseMakeArgs(['--platform', 'linux', '--arch', 'x64'], { platform: 'linux', arch: 'x64' })).toThrow(/unsupported/i);
    expect(() => parseMakeArgs(['--platform', 'darwin', '--arch', 'x64'], { platform: 'darwin', arch: 'x64' })).toThrow(/unsupported/i);
  });

  it('builds Windows installer and portable ZIP with bundled resources outside ASAR', () => {
    const config = builderConfig('C:/staged/payload', 'C:/dist', { platform: 'win32', arch: 'x64' });
    expect(config.win.target).toEqual(['nsis', 'zip']);
    expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, deleteAppDataOnUninstall: false, differentialPackage: false });
    expect(config.asar).toBe(true);
    expect(config.files).toContain('preload.cjs');
    expect(config.files).toContain('window-controls.cjs');
    expect(config.extraResources.map((entry) => entry.to)).toEqual(['payload']);
    expect(config.win.signExecutable).toBe(false);
    expect(config).toMatchObject({ productName: 'Nema Room', executableName: 'Nema', appId: 'org.nema-project.nema-room' });
    expect(config.files).toContain('assets/**/*');
    expect(config.win.icon.replaceAll('\\', '/')).toMatch(/apps\/desktop\/assets\/icon\.ico$/);
  });

  it('requires the source-inventoried Electron notices before packaging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nema-desktop-notices-'));
    try {
      const notices = path.join(root, 'runtime/licenses/electron');
      await mkdir(notices, { recursive: true });
      await writeFile(path.join(notices, 'LICENSE'), 'Electron license');
      await expect(validateElectronNotices(root)).rejects.toThrow(/LICENSES\.chromium\.html/);
      await writeFile(path.join(notices, 'LICENSES.chromium.html'), 'Chromium notices');
      await expect(validateElectronNotices(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('configures macOS DMG and ZIP with explicit ad-hoc signing only', () => {
    const config = builderConfig('/staged/payload', '/dist', { platform: 'darwin', arch: 'arm64' });
    expect(config.mac.target).toEqual(['dmg', 'zip']);
    expect(config.mac).toMatchObject({ identity: '-', hardenedRuntime: false });
    expect(config.mac).not.toHaveProperty('notarize');
    expect(config.mac.icon.replaceAll('\\', '/')).toMatch(/apps\/desktop\/assets\/icon\.icns$/);
  });

  it('uses the standard Windows portable ZIP by default and accepts an explicit artifact path', () => {
    expect(parseSmokeArgs([]).zipFile.replaceAll('\\', '/')).toContain('dist/desktop-artifacts/win32-x64/Nema-0.1.0-win32-x64.zip');
    expect(parseSmokeArgs(['--zip', 'dist/desktop-artifacts-final/win32-x64/Nema-0.1.0-win32-x64.zip']).zipFile.replaceAll('\\', '/')).toContain('desktop-artifacts-final');
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--zip', 'b.zip'])).toThrow(/usage/i);
  });
});
