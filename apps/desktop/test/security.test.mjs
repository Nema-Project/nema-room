import { describe, expect, it } from 'vitest';
import { createSecureWindowOptions, navigationDecision, validateRuntimeLaunchUrl } from '../security.cjs';

describe('Electron renderer security policy', () => {
  it('accepts only a ticket URL at the authenticated runtime origin', () => {
    const origin = 'http://127.0.0.1:43001';
    expect(validateRuntimeLaunchUrl(`${origin}/_nema/launch?ticket=${'a'.repeat(64)}`, origin)).toBe(true);
    expect(() => validateRuntimeLaunchUrl(`http://127.0.0.1:43002/_nema/launch?ticket=${'a'.repeat(64)}`, origin)).toThrow();
    expect(() => validateRuntimeLaunchUrl(`${origin}/_nema/launch?ticket=${'a'.repeat(64)}&next=https://evil.test`, origin)).toThrow();
  });

  it('keeps Node integration off, context isolation and sandbox on, and web security enabled', () => {
    expect(createSecureWindowOptions('http://127.0.0.1:43001').webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
    expect(createSecureWindowOptions('http://127.0.0.1:43001')).toMatchObject({ frame: false, autoHideMenuBar: true });
  });

  it('allows only the expected local origin or credential-free external HTTPS links', () => {
    expect(navigationDecision('http://127.0.0.1:43001/work', 'http://127.0.0.1:43001')).toBe('runtime');
    expect(navigationDecision('https://example.com/docs', 'http://127.0.0.1:43001')).toBe('external');
    for (const url of [
      'http://127.0.0.1:43002/work', 'file:///C:/secret', 'javascript:alert(1)',
      'https://user:pass@example.com/', 'data:text/html,hello', 'chrome://settings',
    ]) expect(navigationDecision(url, 'http://127.0.0.1:43001')).toBe('block');
  });
});
