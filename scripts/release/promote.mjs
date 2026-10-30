// Promote one verified release: npm, then the two GHCR `latest` aliases, then the GitHub Release.
// Every outside action goes through `io`, so the order, the stops and the record are testable with stubs;
// `.github/workflows/release-promote.yml` wires `io` to real commands (see realIo below).
//
// Rules (docs/superpowers/specs/2026-10-28-release-mechanics-design.md, maintainer decision A):
// - any missing/unknown answer or error stops; pointers after that step are not touched
// - each pointer is re-read right before it moves, and never moves backwards (shouldMoveLatest)
// - the tag is re-checked before every write; a moved tag stops the run
// - reruns are idempotent: a step whose re-read shows it done is recorded as already done
// - nothing is rolled back: npm versions are immutable and version tags never move
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyRemoteReleaseTag } from '../desktop/release-commit.mjs';
import { expectedTargets } from '../desktop/release-manifest.mjs';
import { npmPublishState, tarballIntegrity } from './npm-state.mjs';
import { IMAGE_REPOSITORIES, REPOSITORY, readRelease } from './registry-read.mjs';
import { parseVersion, pointerDecisions, readPointers, verifyRelease } from './verify-release.mjs';

const exec = promisify(execFile);
const TARGETS = Object.freeze(['hub', 'web']);

export class PromoteStop extends Error {}

/** The pointers a stable release moves, in order; a prerelease moves npm next and publishes a prerelease. */
function pointerNames(prerelease) {
  return prerelease ? ['npm next', 'github release'] : ['npm latest', 'ghcr hub latest', 'ghcr web latest', 'github latest'];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * @param {object} options
 * @param {string} options.version  x.y.z or x.y.z-pre.n, already matching options.tag
 * @param {string} options.tag      v<version>
 * @param {string} options.commit   the tag commit resolved once at the start; every write re-checks it
 * @param {object} options.io       { expectedIntegrity, verify, npmState, dispatchNpm, waitNpm, readPointers,
 *                                    moveGhcrLatest, releaseState, publishRelease, verifyRemoteTag }
 * @param {(line: string) => Promise<void>|void} options.summary  appends one line to the run record
 */
export async function promote({ version, tag, commit, io, summary }) {
  const { prerelease } = parseVersion(version);
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not name version ${version}`);
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('commit must be a full SHA');
  // Pointers that serve this version now: moved by this run, or found there by a rerun.
  const flipped = [];
  const already = [];
  const done = [];
  const record = async (line) => {
    done.push(line);
    await summary(`- ${line}`);
  };
  const guardTag = async () => {
    try {
      await io.verifyRemoteTag({ tag, commit });
    } catch (error) {
      throw new PromoteStop(`${tag} no longer points at ${commit}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const message = (error) => (error instanceof Error ? error.message : String(error));
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw error instanceof PromoteStop ? error : new PromoteStop(`${name}: ${message(error)}`);
    }
  };
  /** A write whose command failed may still have landed: read back before deciding it did not. */
  const write = async (name, fn, landed) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PromoteStop) throw error;
      let after = false;
      try {
        after = await landed();
      } catch {
        // the read-back failed too; report the write as failed
      }
      if (!after) throw new PromoteStop(`${name}: ${message(error)}`);
      await summary(`- ${name}: the command reported "${message(error)}", but the read-back shows it landed`);
      return undefined;
    }
  };

  await summary(`## promote ${tag} (${commit.slice(0, 12)})`);
  try {
    await guardTag();
    // The image pull smoke and the desktop builds run outside verify-release: their push runs must have passed.
    for (const line of await step('tag workflows', () => io.tagWorkflows())) await record(line);
    const expectedIntegrity = await step('expected integrity', () => io.expectedIntegrity());
    await record(`expected npm tarball ${expectedIntegrity} (from the tag's npm-publish push run)`);

    const candidate = await step('candidate preflight', () => io.verify({ stage: 'candidate', expectedIntegrity }));
    if (candidate.exitCode !== 0) throw new PromoteStop(`candidate preflight is ${candidate.overall}; see the report above`);
    await record('candidate preflight: complete');

    // npm: absent -> dispatch and wait; same -> already published; different -> refuse.
    const npmName = prerelease ? 'npm next' : 'npm latest';
    const npmBefore = await step('npm state', () => io.npmState({ expectedIntegrity }));
    if (npmBefore === 'different') throw new PromoteStop(`npm already holds a different ${version} tarball; refusing`);
    if (npmBefore === 'same') {
      // Published earlier. The dist-tag must agree: OIDC publishing cannot move a dist-tag on its own.
      const pointers = await step('read npm dist-tags', () => io.readPointers());
      const decision = pointerDecisions(pointers, version, prerelease)[npmName];
      const pointer = prerelease ? pointers.npm.next : pointers.npm.latest;
      if (decision === 'unknown') throw new PromoteStop(`${npmName} cannot be read: ${pointer.detail ?? 'unknown'}`);
      if (decision === 'move' && pointer.version !== version) {
        throw new PromoteStop(`npm has ${version} but ${npmName} is ${pointer.version ?? 'absent'}; promote cannot move a dist-tag (trusted publishing only publishes). A maintainer runs: npm dist-tag add @nema-project/nema@${version} ${prerelease ? 'next' : 'latest'}`);
      }
      // An older stable may stay under maintenance; an older prerelease has no such place and is not promoted.
      if (prerelease && decision === 'keep') throw new PromoteStop(`npm next is ${pointer.version}, newer than ${version}; an older prerelease is not promoted`);
      if (pointer.version === version) already.push(npmName);
      await record(`npm ${version}: already published with the expected tarball; ${npmName} is ${pointer.version ?? 'absent'}`);
    } else if (npmBefore === 'absent') {
      const pointers = await step('read npm dist-tags', () => io.readPointers());
      const decision = pointerDecisions(pointers, version, prerelease)[npmName];
      if (decision === 'unknown') throw new PromoteStop(`${npmName} cannot be read before publishing`);
      // npm-publish sends an older stable to maintenance; an older prerelease has no such tag, so refuse it.
      if (prerelease && decision === 'keep') throw new PromoteStop(`npm next is ${pointers.npm.next.version}, newer than ${version}; publishing would move next backwards`);
      const before = prerelease ? pointers.npm.next : pointers.npm.latest;
      await guardTag();
      const published = async () => (await io.npmState({ expectedIntegrity })) === 'same';
      const run = await write('npm publish run', async () => {
        const dispatched = await io.dispatchNpm({ tag, commit, expectedIntegrity });
        await io.waitNpm(dispatched);
        return dispatched;
      }, published);
      if (!(await step('npm state after publish', published))) throw new PromoteStop('npm publish run finished but the registry does not hold the expected tarball');
      const after = await step('read npm dist-tags after publish', () => io.readPointers());
      const tagNow = prerelease ? after.npm.next : after.npm.latest;
      const by = run ? ` by run ${run.id ?? run}` : '';
      if (decision === 'keep' && tagNow.state === 'version' && tagNow.version === version) {
        // The pointer was newer before the dispatch: a publish that took it is a backwards move, not a promotion.
        throw new PromoteStop(`${npmName} moved backwards from ${before.version} to ${version}; a maintainer restores it with npm dist-tag add @nema-project/nema@${before.version} ${prerelease ? 'next' : 'latest'}`);
      }
      if (tagNow.state === 'version' && tagNow.version === version) {
        flipped.push(npmName);
        await record(`npm ${version}: published${by}; ${npmName} -> ${version}`);
      } else if (!prerelease && pointerDecisions(after, version, false)['npm latest'] === 'keep') {
        // Only an explicitly newer latest explains a stable publish that left latest alone (maintenance).
        await record(`npm ${version}: published${by} under maintenance; ${npmName} stays ${tagNow.version}`);
      } else {
        throw new PromoteStop(`npm ${version} is published but ${npmName} reads ${tagNow.version ?? tagNow.state}${tagNow.detail ? ` (${tagNow.detail})` : ''}; not moving any other pointer`);
      }
    } else {
      throw new PromoteStop(`npm state is ${JSON.stringify(npmBefore)}`);
    }

    const final = await step('final verify', () => io.verify({ stage: 'final' }));
    if (final.exitCode !== 0) throw new PromoteStop(`final verify is ${final.overall}; see the report above`);
    await record('final verify: complete');

    if (!prerelease) {
      for (const target of TARGETS) {
        const name = `ghcr ${target} latest`;
        // Bind latest to the exact index final verify read, not to whatever the version tag says later.
        const digest = final.items?.images?.evidence?.[target]?.digest;
        if (!DIGEST.test(digest ?? '')) throw new PromoteStop(`final verify did not record a digest for ${target} ${version}`);
        const pointers = await step(`read ${name}`, () => io.readPointers());
        const pointer = pointers.ghcr[target];
        if (pointer.state === 'version' && pointer.version === version && pointer.digest === digest) {
          already.push(name);
          await record(`${name}: already ${version} (${digest})`);
          continue;
        }
        // Same label but another index is not this release: decide as for an equal version, which moves.
        const decision = pointerDecisions(pointers, version, false)[name];
        if (decision === 'unknown') throw new PromoteStop(`${name} cannot be read: ${pointer.detail ?? 'unknown'}`);
        if (decision === 'keep') {
          await record(`${name}: kept at ${pointer.version} (newer than ${version})`);
          continue;
        }
        await guardTag();
        await write(`move ${name}`, () => io.moveGhcrLatest({ target, version, digest }), async () => {
          const reread = (await io.readPointers()).ghcr[target];
          return reread.state === 'version' && reread.digest === digest;
        });
        flipped.push(name);
        await record(`${name}: ${pointer.version ?? 'absent'} -> ${version} (${digest})`);
      }
    }

    const release = await step('read release', () => io.releaseState({ tag }));
    let makeLatest = false;
    if (!prerelease) {
      const pointers = await step('read github latest', () => io.readPointers());
      const pointer = pointers.github.latest;
      if (pointer.state === 'version' && pointer.version === version) {
        makeLatest = null; // already latest
      } else {
        const decision = pointerDecisions(pointers, version, false)['github latest'];
        if (decision === 'unknown') throw new PromoteStop(`GitHub latest release cannot be read: ${pointer.detail ?? 'unknown'}`);
        makeLatest = decision === 'move';
      }
    }
    const flagRight = release.prerelease === undefined || release.prerelease === prerelease;
    if (!release.draft && makeLatest !== true && flagRight) {
      if (makeLatest === null) already.push('github latest');
      if (prerelease) already.push('github release');
      await record(`GitHub Release ${tag}: already published${makeLatest === null ? ' and latest' : ''}`);
    } else {
      // A draft to publish, or a published stable Release that should be latest but is not (reconciled here).
      await guardTag();
      // A desktop-release rerun started since the first check may be replacing draft assets: its newest run
      // must again be complete and green right before the draft goes public.
      if (release.draft) await step('tag workflows before the release', () => io.tagWorkflows());
      const latestFlag = makeLatest === true;
      await write('publish release', () => io.publishRelease({ tag, prerelease, makeLatest: latestFlag }), async () => {
        const reread = await io.releaseState({ tag });
        if (reread.draft || reread.prerelease !== prerelease) return false;
        if (!latestFlag) return true;
        const latest = (await io.readPointers()).github.latest;
        return latest.state === 'version' && latest.version === version;
      });
      flipped.push(prerelease ? 'github release' : latestFlag ? 'github latest' : 'github release (not latest)');
      const what = release.draft ? 'published' : flagRight ? 'already published, now marked latest' : `already published, prerelease flag corrected to ${prerelease}`;
      await record(`GitHub Release ${tag}: ${what}${prerelease ? ' as prerelease' : ''}, latest=${latestFlag}`);
    }
    await summary(`\npromote ${tag}: done`);
    return { ok: true, flipped, already, done };
  } catch (error) {
    const reason = message(error);
    const live = [...flipped, ...already];
    const notFlipped = pointerNames(prerelease).filter((name) => !live.includes(name));
    await summary(`\n**promote ${tag} stopped:** ${reason}`);
    await summary(`- flipped by this run: ${flipped.length ? flipped.join(', ') : 'none'}`);
    if (already.length) await summary(`- already on ${version} before this run: ${already.join(', ')}`);
    await summary(`- not flipped: ${notFlipped.length ? notFlipped.join(', ') : 'none'}`);
    if (live.length && notFlipped.length) await summary('- partial window: some pointers already serve this version and others do not; rerun promote after fixing the cause to finish the rest');
    return { ok: false, flipped, already, done, reason };
  }
}

// ---------- real io (used by .github/workflows/release-promote.yml) ----------

async function run(command, args, options = {}) {
  const { stdout } = await exec(command, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  return stdout.trim();
}

/**
 * A tag push runs the complete verify.yml (every input defaults to true), so every verify job must have run
 * and passed, none skipped, and each required group must be there; the build job must have passed too.
 */
/** Every job a tag push of verify.yml runs, matrix legs by exact name (workflows.test derives them from verify.yml). */
export const VERIFY_JOBS = Object.freeze([
  'verify / Workflow lint',
  'verify / Full application tests and web build',
  'verify / Platform checks (macos-latest)',
  'verify / Platform checks (windows-latest)',
  'verify / npm pack smoke (ubuntu-latest)',
  'verify / npm pack smoke (windows-latest)',
  'verify / npm pack smoke (macos-latest)',
]);
export const REQUIRED_PUSH_JOBS = Object.freeze(['Pack and smoke nema', ...VERIFY_JOBS]);

/** Each required job by exact name: present and successful (a missing matrix leg is a missing job). */
function requireJobs(jobs, required, label) {
  for (const name of required) {
    const matched = jobs.filter((job) => job?.name === name);
    if (matched.length === 0 || !matched.every((job) => job.conclusion === 'success')) {
      throw new Error(`${label}: ${name} did not run and pass (${matched.map((job) => `${job.name}=${job.conclusion}`).join(', ') || 'no such job'})`);
    }
  }
}

export function assertPushRunJobs(jobs, id, totalCount) {
  // A failed job on a page this list does not hold would go unseen: the list must be the whole run.
  if (!Number.isInteger(totalCount)) throw new Error(`npm-publish push run ${id}: the jobs API did not report its job count`);
  if (jobs.length !== totalCount) throw new Error(`npm-publish push run ${id}: the jobs answer lists ${jobs.length} of ${totalCount} jobs`);
  const named = jobs.filter((job) => typeof job?.name === 'string');
  requireJobs(named, REQUIRED_PUSH_JOBS, `npm-publish push run ${id}`);
  const other = named.filter((job) => job.name.startsWith('verify / ') && job.conclusion !== 'success');
  if (other.length) throw new Error(`npm-publish push run ${id}: ${other.map((job) => `${job.name}=${job.conclusion}`).join(', ')}`);
}

/** Jobs the image and desktop push runs of a tag must have run and passed; verify-release cannot see them. */
export const REQUIRED_TAG_RUN_JOBS = Object.freeze({
  'image-publish.yml': Object.freeze(['Resolve release version', ...VERIFY_JOBS, 'Build and smoke images', 'Publish images', 'Pull published images']),
  'desktop-release.yml': Object.freeze(['Resolve release version', ...VERIFY_JOBS, ...expectedTargets.map((target) => `Build and smoke (${target})`), 'Publish release']),
});

export function assertTagRunJobs(workflow, jobs, id, totalCount) {
  const required = REQUIRED_TAG_RUN_JOBS[workflow];
  if (!required) throw new Error(`${workflow}: no job list to check`);
  const name = workflow.replace(/\.yml$/, '');
  if (!Number.isInteger(totalCount)) throw new Error(`${name} push run ${id}: the jobs API did not report its job count`);
  if (jobs.length !== totalCount) throw new Error(`${name} push run ${id}: the jobs answer lists ${jobs.length} of ${totalCount} jobs`);
  requireJobs(jobs, required, `${name} push run ${id}`);
  // A tag push runs every job of these workflows: none may be skipped, cancelled or failed.
  const other = jobs.filter((job) => job?.conclusion !== 'success');
  if (other.length) throw new Error(`${name} push run ${id}: ${other.map((job) => `${job?.name}=${job?.conclusion}`).join(', ')}`);
}

/** The workflow runs answer for one commit must hold every run: the newest run of the tag could be on a page not read. */
export function completeRuns(answer, label) {
  const runs = answer?.workflow_runs;
  if (!Array.isArray(runs) || !Number.isInteger(answer?.total_count)) throw new Error(`${label}: the runs API did not report its run count`);
  if (runs.length !== answer.total_count) throw new Error(`${label}: the runs answer lists ${runs.length} of ${answer.total_count} runs`);
  return runs;
}

/** The latest image-publish and desktop-release push runs of the tag commit, each checked job by job. */
async function tagWorkflowRuns({ tag, commit, gh }) {
  const lines = [];
  for (const workflow of Object.keys(REQUIRED_TAG_RUN_JOBS)) {
    const name = workflow.replace(/\.yml$/, '');
    const runs = completeRuns(JSON.parse(await run(gh, ['api', `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?event=push&head_sha=${commit}&per_page=100`])), `${name} push runs at ${commit}`);
    // The newest push run of this tag decides: a later failed rerun is not hidden behind an older success.
    const latest = runs.filter((item) => item.head_branch === tag && item.head_sha === commit).sort((a, b) => b.id - a.id)[0];
    if (!latest) throw new Error(`no ${name} push run for ${tag} at ${commit}`);
    if (latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`${name} push run ${latest.id} is ${latest.status}/${latest.conclusion}`);
    const answer = JSON.parse(await run(gh, ['api', `repos/${REPOSITORY}/actions/runs/${latest.id}/jobs?per_page=100`]));
    assertTagRunJobs(workflow, answer.jobs ?? [], latest.id, answer.total_count);
    lines.push(`${name} push run ${latest.id}: success, all ${answer.total_count} jobs passed (${REQUIRED_TAG_RUN_JOBS[workflow].filter((job) => !job.startsWith('verify / ')).join(', ')} and the verify suite)`);
  }
  return lines;
}

/** Finds the tag's npm-publish push run, checks it, downloads nema-tarball and hashes it. */
async function pushRunIntegrity({ tag, commit, gh }) {
  const runs = completeRuns(JSON.parse(await run(gh, ['api', `repos/${REPOSITORY}/actions/workflows/npm-publish.yml/runs?event=push&head_sha=${commit}&per_page=100`])), `npm-publish push runs at ${commit}`);
  const push = runs.filter((item) => item.head_branch === tag && item.conclusion === 'success').sort((a, b) => b.id - a.id)[0];
  if (!push) throw new Error(`no successful npm-publish push run for ${tag} at ${commit}`);
  // A successful run is not enough: its verify and build jobs must have run and passed.
  const answer = JSON.parse(await run(gh, ['api', `repos/${REPOSITORY}/actions/runs/${push.id}/jobs?per_page=100`]));
  assertPushRunJobs(answer.jobs ?? [], push.id, answer.total_count);
  const dir = await mkdtemp(path.join(tmpdir(), 'promote-npm-'));
  try {
    try {
      await run(gh, ['run', 'download', String(push.id), '-R', REPOSITORY, '-n', 'nema-tarball', '-D', dir]);
    } catch (error) {
      throw new Error(`cannot download nema-tarball from push run ${push.id} (expired after the retention window?): ${error.message}`);
    }
    const files = (await readdir(path.join(dir, 'dist-npm'))).filter((name) => /^nema-project-nema-.+\.tgz$/.test(name));
    if (files.length !== 1) throw new Error(`push run ${push.id} artifact holds ${files.length} nema tarballs`);
    return tarballIntegrity(path.join(dir, 'dist-npm', files[0]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function realIo({ env = process.env, fetchImpl = globalThis.fetch, version, tag, commit, log = (text) => process.stdout.write(text) }) {
  const gh = env.GH_BIN || 'gh';
  const crane = env.CRANE_BIN;
  // release-promote.yml holds contents: write, which sees draft Releases in the list; say so instead of
  // relying on GET /repos returning `permissions` for an installation token.
  const readIo = { fetchImpl, token: env.GITHUB_TOKEN || null, draftsVisible: env.RELEASE_PROMOTE_SEES_DRAFTS === 'true' };
  let expected;
  return {
    tagWorkflows: () => tagWorkflowRuns({ tag, commit, gh }),
    async expectedIntegrity() {
      expected = await pushRunIntegrity({ tag, commit, gh });
      return expected;
    },
    async verify({ stage, expectedIntegrity }) {
      const report = await verifyRelease({ version, stage, expectedIntegrity, io: readIo });
      log(`${JSON.stringify({ stage, overall: report.overall, items: Object.fromEntries(Object.entries(report.items).map(([key, item]) => [key, `${item.state}: ${item.detail}`])) }, null, 2)}\n`);
      return report;
    },
    async npmState({ expectedIntegrity }) {
      return (await npmPublishState({ version, expectedIntegrity, fetchImpl })).state;
    },
    async dispatchNpm({ expectedIntegrity }) {
      // return_run_details (GitHub, 2026-02) answers with the created run's id: no guessing from a run list.
      const answer = JSON.parse(await run(gh, ['api', '-X', 'POST', `repos/${REPOSITORY}/actions/workflows/npm-publish.yml/dispatches`,
        '-f', `ref=${tag}`, '-f', `inputs[promote_run_id]=${env.GITHUB_RUN_ID}`, '-f', `inputs[expected_integrity]=${expectedIntegrity}`, '-F', 'return_run_details=true']) || '{}');
      if (!Number.isInteger(answer.workflow_run_id)) throw new Error(`the npm-publish dispatch did not return a run id: ${JSON.stringify(answer)}`);
      return { id: answer.workflow_run_id };
    },
    async waitNpm({ id }) {
      const deadline = Date.now() + 60 * 60_000;
      while (Date.now() < deadline) {
        const view = JSON.parse(await run(gh, ['run', 'view', String(id), '-R', REPOSITORY, '--json', 'status,conclusion,headSha']));
        if (view.headSha !== commit) throw new Error(`npm-publish run ${id} is for ${view.headSha}, not ${commit}`);
        if (view.status === 'completed') {
          if (view.conclusion !== 'success') throw new Error(`npm-publish run ${id} concluded ${view.conclusion}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
      throw new Error(`npm-publish run ${id} did not finish within 60 minutes`);
    },
    readPointers: () => readPointers(readIo),
    async moveGhcrLatest({ target, version: next, digest }) {
      if (!crane) throw new Error('CRANE_BIN is not set');
      const image = `ghcr.io/${IMAGE_REPOSITORIES[target]}`;
      const current = await run(crane, ['digest', `${image}:${next}`]);
      if (current !== digest) throw new PromoteStop(`${image}:${next} is now ${current}, not the verified ${digest}`);
      // Tag the verified index by digest, so a version tag rewritten after verify cannot become latest.
      await run(crane, ['tag', `${image}@${digest}`, 'latest']);
    },
    async releaseState() {
      // The same draft-aware reader verify-release uses: the by-tag endpoint never returns a draft.
      const release = await readRelease(readIo, tag);
      if (release.state !== 'ok') throw new Error(`release ${tag} is ${release.state}: ${release.detail}`);
      return { draft: release.evidence.isDraft, prerelease: release.evidence.isPrerelease };
    },
    async publishRelease({ prerelease, makeLatest }) {
      // Set the prerelease flag from the tag both ways: a reused draft may carry a stale one.
      await run(gh, ['release', 'edit', tag, '-R', REPOSITORY, '--draft=false', `--prerelease=${prerelease}`, `--latest=${makeLatest}`]);
    },
    verifyRemoteTag: ({ tag: name, commit: sha }) => verifyRemoteReleaseTag({ cwd: process.cwd(), ref: `refs/tags/${name}`, commit: sha }),
  };
}

const USAGE = 'Usage: promote.mjs [--preflight] <vX.Y.Z> <tag-commit-sha>  (run by release-promote.yml; writes $GITHUB_STEP_SUMMARY)';

/** The workflow's `Candidate preflight` step: same checks promote starts with, as their own visible step. */
export async function preflight({ version, io }) {
  for (const line of await io.tagWorkflows()) process.stdout.write(`${line}\n`);
  const expectedIntegrity = await io.expectedIntegrity();
  const report = await io.verify({ stage: 'candidate', expectedIntegrity });
  return { ok: report.exitCode === 0, overall: report.overall, expectedIntegrity };
}

export async function main(argv, { env = process.env } = {}) {
  const isPreflight = argv[0] === '--preflight';
  const [tag, commit, extra] = isPreflight ? argv.slice(1) : argv;
  if (!/^v/.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '') || extra !== undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 64;
  }
  const version = tag.slice(1);
  parseVersion(version);
  if (isPreflight) {
    const result = await preflight({ version, io: realIo({ env, version, tag, commit }) });
    process.stdout.write(`candidate preflight ${tag}: ${result.overall}\n`);
    // release-promote.yml records what this preflight verified for npm-publish to compare with its dispatch.
    if (result.ok && env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `integrity=${result.expectedIntegrity}\n`);
    return result.ok ? 0 : 1;
  }
  const summary = async (line) => {
    process.stdout.write(`${line}\n`);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const result = await promote({ version, tag, commit, io: realIo({ env, version, tag, commit }), summary });
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`promote failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
