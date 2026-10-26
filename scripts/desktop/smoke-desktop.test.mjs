import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { nsisSilentCommandLine, parseSmokeArgs } from './smoke-desktop.mjs';

test('the smoke takes the Windows installer, not a portable ZIP', () => {
  assert.equal(parseSmokeArgs(['--installer', 'dist/Nema-0.1.1-win32-x64.exe']).installer, path.resolve('dist/Nema-0.1.1-win32-x64.exe'));
  assert.match(parseSmokeArgs([]).installer, /Nema-.+-win32-x64\.exe$/);
  assert.throws(() => parseSmokeArgs(['--zip', 'Nema.zip']), /Usage/);
  assert.throws(() => parseSmokeArgs(['--installer']), /Usage/);
});

test('NSIS gets /D= last and unquoted, even for a path with spaces and Japanese characters', () => {
  const dir = path.join('C:', 'Temp', 'Nema proof 東京', 'installed app with spaces');
  assert.equal(nsisSilentCommandLine(dir), `/S /D=${dir}`);
});
