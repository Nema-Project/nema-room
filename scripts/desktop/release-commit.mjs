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

export async function verifyRemoteReleaseTag({cwd, ref, commit}) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/tags/') || !/^[a-f0-9]{40,64}$/i.test(commit ?? '')) throw new Error('Expected tag ref and immutable commit SHA');
  await exec('git', ['check-ref-format', ref], {cwd});
  // A dedicated local ref avoids trusting stale tags left by checkout or a previous check.
  const fetchedRef = 'refs/nema-release/verified-tag';
  await exec('git', ['fetch', '--no-tags', 'origin', `+${ref}:${fetchedRef}`], {cwd});
  const {stdout} = await exec('git', ['rev-parse', '--verify', `${fetchedRef}^{commit}`], {cwd});
  if (stdout.trim() !== commit) throw new Error('Remote release tag moved; commit mismatch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--verify-remote') {
    await verifyRemoteReleaseTag({cwd:process.cwd(), ref:process.argv[3], commit:process.argv[4]});
    console.log('Remote tag still identifies the verified release commit');
  } else {
    console.log(await resolveReleaseCommit({cwd:process.cwd(), ref:process.argv[2], mainRef:process.argv[3]}));
  }
}
