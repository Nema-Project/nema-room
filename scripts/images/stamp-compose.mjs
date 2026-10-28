import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderComposeAsset } from './check-images.mjs';

export async function stampCompose({ root, version, out = null }) {
  const templatePath = path.resolve(root, 'docker-compose.yml');
  if (out !== null && path.resolve(out) === templatePath) throw new Error('refusing to overwrite the compose template');
  const text = renderComposeAsset(await readFile(templatePath, 'utf8'), version);
  if (out !== null) {
    const destination = path.resolve(out);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { text, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const positional = args.filter(arg => arg !== '--check');
    if (args.filter(arg => arg === '--check').length > 1 || positional.length < 1 || positional.length > (check ? 1 : 2)) {
      throw new Error('Usage: stamp-compose.mjs <version> [path] | --check <version>');
    }
    const [version, out] = positional;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = await stampCompose({ root, version, out: out ?? null });
    const success = `compose asset: ${version} ok\n`;
    if (check) process.stdout.write(success);
    else if (out) process.stderr.write(`wrote ${out}\n${success}`);
    else { process.stdout.write(result.text); process.stderr.write(success); }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
