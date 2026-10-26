import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

export async function resolveReleaseCommit({cwd, ref, mainRef}) {
  for (const value of [ref, mainRef]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..')) throw new Error('Invalid release ref');
  }
  const {stdout} = await exec('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {cwd});
  const commit = stdout.trim();
  await exec('git', ['merge-base', '--is-ancestor', commit, mainRef], {cwd});
  return commit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await resolveReleaseCommit({cwd:process.cwd(), ref:process.argv[2], mainRef:process.argv[3]}));
}
