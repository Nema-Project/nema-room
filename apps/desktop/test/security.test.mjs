import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDiagramWindowOptions, createSecureWindowOptions, isDiagramWindowUrl, isMainMessageUrl, isThreadWindowUrl, navigationDecision, usesNativeTrafficLights, validateRuntimeLaunchUrl } from '../security.cjs';

describe('Electron renderer security policy', () => {
  it('accepts only a ticket URL at the authenticated runtime origin', () => {
    const origin = 'http://127.0.0.1:43001';
    expect(validateRuntimeLaunchUrl(`${origin}/_nema/launch?ticket=${'a'.repeat(64)}`, origin)).toBe(true);
    expect(() => validateRuntimeLaunchUrl(`http://127.0.0.1:43002/_nema/launch?ticket=${'a'.repeat(64)}`, origin)).toThrow();
    expect(() => validateRuntimeLaunchUrl(`${origin}/_nema/launch?ticket=${'a'.repeat(64)}&next=https://evil.test`, origin)).toThrow();
  });

  it('keeps Node integration off, context isolation and sandbox on, and web security enabled', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(createSecureWindowOptions('http://127.0.0.1:43001', platform).webPreferences).toMatchObject({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      });
      expect(createSecureWindowOptions('http://127.0.0.1:43001', platform).title).toBe('Nema Room');
      expect(createSecureWindowOptions('http://127.0.0.1:43001', platform).autoHideMenuBar).toBe(true);
    }
  });

  it('uses native macOS traffic lights and keeps custom chrome on Windows and Linux', () => {
    expect(usesNativeTrafficLights('darwin')).toBe(true);
    expect(usesNativeTrafficLights('win32')).toBe(false);
    expect(usesNativeTrafficLights('linux')).toBe(false);
    const mac = createSecureWindowOptions('http://127.0.0.1:43001', 'darwin');
    expect(mac).toMatchObject({ frame: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 11 } });
    for (const platform of ['win32', 'linux']) {
      const options = createSecureWindowOptions('http://127.0.0.1:43001', platform);
      expect(options).toMatchObject({ frame: false });
      expect(options.titleBarStyle).toBeUndefined();
      expect(options.trafficLightPosition).toBeUndefined();
    }
    const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
    expect(preload).toContain("nativeTrafficLights: process.platform === 'darwin'");
    const css = readFileSync(new URL('../../web/app/globals.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.desktop-titlebar-macos\s*\{[^}]*padding-left:\s*80px/);
    expect(css).toMatch(/\.desktop-titlebar-macos\.desktop-titlebar-fullscreen\s*\{[^}]*padding-left:\s*14px/);
    expect(css).toMatch(/\.desktop-titlebar\s*\{[^}]*-webkit-app-region:\s*drag/);
  });

  it('allows only the expected local origin or credential-free external HTTPS links', () => {
    expect(navigationDecision('http://127.0.0.1:43001/work', 'http://127.0.0.1:43001')).toBe('runtime');
    expect(navigationDecision('https://example.com/docs', 'http://127.0.0.1:43001')).toBe('external');
    for (const url of [
      'http://127.0.0.1:43002/work', 'file:///C:/secret', 'javascript:alert(1)',
      'https://user:pass@example.com/', 'data:text/html,hello', 'chrome://settings',
    ]) expect(navigationDecision(url, 'http://127.0.0.1:43001')).toBe('block');
  });

  it('allows a diagram popup only for a same-origin diagram html path', () => {
    const origin = 'http://127.0.0.1:43001';
    const diagram = `${origin}/api/workspaces/ws_abc/diagrams/G-1.html`;
    expect(isDiagramWindowUrl(diagram, origin)).toBe(true);
    expect(isDiagramWindowUrl('/api/workspaces/ws_abc/diagrams/G-12.html', origin)).toBe(true);
    for (const url of [
      `${origin}/`,
      `${origin}/api/workspaces/ws_abc/diagrams/G-1.html?x=1`,
      `${origin}/api/workspaces/ws_abc/diagrams/G-1.html#x`,
      `${origin}/api/workspaces/ws_abc/entries/G-1`,
      `${origin}/api/workspaces/nope/diagrams/G-1.html`,
      'http://127.0.0.1:43002/api/workspaces/ws_abc/diagrams/G-1.html',
      'https://example.com/api/workspaces/ws_abc/diagrams/G-1.html',
      `${origin}/api/workspaces/ws_abc/diagrams/G-1.html/../../`,
    ]) expect(isDiagramWindowUrl(url, origin)).toBe(false);
    expect(createDiagramWindowOptions().webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
    expect(createDiagramWindowOptions().webPreferences.preload).toBeUndefined();
    expect(createDiagramWindowOptions().frame).not.toBe(false);
  });

  it('allows a thread popup only at its canonical same-origin path with an optional valid focus target', () => {
    const origin = 'http://127.0.0.1:43001';
    expect(isThreadWindowUrl(`${origin}/w/ws_abc/t/m_xyz`, origin)).toBe(true);
    expect(isThreadWindowUrl('/w/ws_abc/t/m_xyz?messageId=m_target-1', origin)).toBe(true);
    for (const url of [
      `${origin}/w/ws_abc/t/m_xyz?bad=1`,
      `${origin}/w/ws_abc/t/m_xyz?messageId=bad`,
      `${origin}/w/ws_abc/t/m_xyz?messageId=m_a&messageId=m_b`,
      `${origin}/w/ws_abc/t/m_xyz#focus`,
      `${origin}/w/ws_abc/t/m_xyz/extra`,
      `${origin}/w/ws_abc/t/m_xyz/../../`,
      'http://127.0.0.1:43002/w/ws_abc/t/m_xyz',
    ]) expect(isThreadWindowUrl(url, origin)).toBe(false);
  });

  it('parses only the canonical main-message focus URL shape', () => {
    const origin = 'http://127.0.0.1:43001';
    const valid = `${origin}/w/ws_abc#workspace=ws_abc&message=m_xyz`;
    expect(isMainMessageUrl(valid, origin)).toEqual({ workspaceId: 'ws_abc', messageId: 'm_xyz' });
    for (const url of [
      `${origin}/w/ws_abc?x=1#workspace=ws_abc&message=m_xyz`,
      `${origin}/w/ws_abc#workspace=ws_other&message=m_xyz`,
      `${origin}/w/ws_abc#workspace=ws_abc&message=m_xyz&extra=1`,
      `${origin}/w/ws_abc#workspace=ws_abc&workspace=ws_abc&message=m_xyz`,
      `${origin}/w/ws_abc#workspace=ws_abc&message=m_xyz&message=m_xyz`,
      `${origin}/w/ws_abc#workspace=ws_abc&message=bad`,
      `${origin}/w/ws_abc/extra#workspace=ws_abc&message=m_xyz`,
      `http://user:pass@127.0.0.1:43001/w/ws_abc#workspace=ws_abc&message=m_xyz`,
      'http://127.0.0.1:43002/w/ws_abc#workspace=ws_abc&message=m_xyz',
      `${origin}/w/ws_abc#workspace=ws_abc&message=m_xyz\r\n`,
      `${origin}/w/ws_abc#workspace=ws_abc&message=m_xyz\0`,
    ]) expect(isMainMessageUrl(url, origin)).toBeNull();
  });
});
