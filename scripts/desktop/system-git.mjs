import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Directory of the git on this machine's PATH. The desktop smokes give the app a minimal PATH, and Nema
 * now relies on the user's own git rather than a bundled one, so that directory must be on it.
 */
export function systemGitDirectory() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  let found = '';
  try { found = execFileSync(finder, ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); }
  catch { /* reported below */ }
  if (!found) throw new Error('The desktop smoke needs git on PATH: Nema uses the system git, as users must install it');
  return path.dirname(found);
}
