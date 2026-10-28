import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { classifyPaths } from './policy.mjs';
const exec = promisify(execFile);

export async function changedPaths({cwd, base, head}) {
  for (const ref of [base, head]) if (typeof ref !== 'string' || !/^[a-f0-9]{40,64}$/i.test(ref)) throw new Error('Expected immutable commit SHA');
  // `head` is the commit under test. A pull request passes github.sha (the merge
  // ref), not the branch tip: two-dot against a tip behind base lists base's newer files.
  const {stdout} = await exec('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'], {cwd, maxBuffer:64 * 1024 * 1024});
  return stdout ? stdout.slice(0, -1).split('\0') : [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = await changedPaths({cwd:process.cwd(), base:process.argv[2], head:process.argv[3]});
  const result = classifyPaths(paths);
  const file = process.env.PATH_LIST_FILE;
  if (!file || !process.env.GITHUB_OUTPUT) throw new Error('PATH_LIST_FILE and GITHUB_OUTPUT are required');
  await writeFile(file, JSON.stringify(paths));
  const lines = [
    `mode=${result.mode}`,
    `platform=${result.platform}`,
    `npm_pack=${result.npmPack}`,
    `desktop=${result.desktop}`,
    `image=${result.image}`,
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(`Classified ${paths.length} changed paths: ${result.mode}`);
}
