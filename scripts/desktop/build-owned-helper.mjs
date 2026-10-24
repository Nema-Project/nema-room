import { mkdir, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(args) {
  const result = { output: null, testOnly: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--output') result.output = args[++index] ?? null;
    else if (arg === '--test-only') result.testOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!result.output) throw new Error('Usage: build-owned-helper.mjs --output <owned-helper.exe> [--test-only]');
  return result;
}

export async function buildOwnedHelper({ output, sourceRoot = root, testOnly = false, compiler = process.env.NEMA_WINDOWS_NATIVE_CC ?? 'clang' } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The owned-helper guardian currently builds only on a native Windows x64 host');
  if (!output) throw new Error('An explicit owned-helper output path is required');
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  const source = path.join(path.resolve(sourceRoot), 'apps/cli/native/windows/owned-helper.c');
  const args = ['-Wall', '-Wextra', '-Werror', '-municode', '-O2'];
  if (testOnly) args.push('-DNEMA_GUARDIAN_TESTING=1');
  args.push(source, '-o', output);
  const result = spawnSync(compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`Could not start Windows native compiler ${compiler}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Windows native guardian compiler failed with status ${result.status ?? result.signal}`);
  await chmod(output, 0o755);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const output = await buildOwnedHelper(options);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
