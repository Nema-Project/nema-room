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
import { shouldMoveLatest } from '../images/check-images.mjs';
import { probeNpmVersion, tarballIntegrity } from './npm-state.mjs';
import { IMAGE_REPOSITORIES, REPOSITORY, npmProvenanceDeclared, readNpmProvenance, readNpmPublishedAt, readRelease } from './registry-read.mjs';
import { npmPointers, parseVersion, pointerDecisions, readPointers, verifyRelease } from './verify-release.mjs';

const exec = promisify(execFile);
const TARGETS = Object.freeze(['hub', 'web']);

export class PromoteStop extends Error {}

/** The pointers a stable release moves, in order; a prerelease moves npm next and publishes a prerelease. */
function pointerNames(prerelease) {
  return prerelease ? ['npm next', 'github release'] : ['npm latest', 'ghcr hub latest', 'ghcr web latest', 'github latest'];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** How long a promote run keeps re-reading npm before it calls the registry's answer final. */
export const NPM_VISIBILITY_BUDGET_MS = 120_000;
export const NPM_VISIBILITY_POLL_MS = 5_000;
/**
 * How long after its publish a version's provenance can still be an index delay. A version older than
 * this whose version document declares no attestation is not lagging any more: it was published
 * without provenance (#174).
 */
export const NPM_PROVENANCE_INDEX_WINDOW_MS = 300_000;

/** `not-visible` is a definitive "still not there"; `unknown` is not, and must be recorded as unknown. */
const NOT_VISIBLE = 'not-visible';
const UNKNOWN = 'unknown';
/** The package is on npm but its channel pointer never moved: published, not "not written". */
const TAG_NOT_CONFIRMED = 'tag-not-confirmed';

// Provenance outcomes (#174). The first two are different certainties about the same event and must never
// be reported as each other; neither means "the package was not written".
/** An attestation exists but is not served yet: the version document declares one, or the publish is recent. */
const PROVENANCE_NOT_INDEXED = 'provenance-not-indexed';
/** Nothing shows whether an attestation exists: the budget ended without an answer either way. */
const PROVENANCE_UNCONFIRMED = 'provenance-unconfirmed';
/** The registry holds no SLSA v1 provenance for this version, and waiting cannot change that. */
const PROVENANCE_ABSENT = 'provenance-absent';
/** 401/403: this reader may not see the attestation, and another read will not change that. */
const PROVENANCE_DENIED = 'provenance-denied';
/** Outcomes a rerun can still fix, as opposed to an answer the registry will keep giving. */
const PROVENANCE_WAITABLE = Object.freeze([PROVENANCE_NOT_INDEXED, PROVENANCE_UNCONFIRMED]);
const DEFINITE_PROVENANCE = new Set([PROVENANCE_ABSENT, PROVENANCE_DENIED]);
/** What a maintainer is told to do about a waitable provenance item, in the run record. */
const WAITABLE_RERUN = 'Rerun promote when the index has caught up: it reads the attestation again and finishes the pointers this run left alone.';
/** What a maintainer is told to do about a provenance the registry does not have. */
const PROVENANCE_FIX = 'Nothing here can add it: a version is immutable, so the release needs a new tag published with trusted publishing.';

/** One run-record phrase per provenance outcome: never the same words for "not indexed" and "none". */
export function provenanceNote(provenance) {
  if (!provenance) return 'provenance not settled';
  const waited = provenance.waitedMs > 0 ? ` after ${provenance.waitedMs}ms` : '';
  switch (provenance.outcome) {
    case 'ok': return `provenance served${waited}`;
    case PROVENANCE_NOT_INDEXED: return `provenance declared but not served${waited}`;
    case PROVENANCE_UNCONFIRMED: return `provenance not confirmed${waited}`;
    case PROVENANCE_ABSENT: return `no provenance${waited}`;
    case PROVENANCE_DENIED: return `provenance not readable${waited}`;
    default: return `provenance ${provenance.outcome}${waited}`;
  }
}

/**
 * One budget, one clock: the wait phases below share a deadline and one run-log format, so a stop is
 * never later than the budget and every line carries the time already spent.
 */
function waitScope({ io, budgetMs, pollMs, onPoll }) {
  const started = io.now();
  const deadline = started + budgetMs;
  return {
    budgetMs,
    spent: () => io.now() - started,
    /** Sleep only what the budget still allows; false means the budget is spent. */
    async more() {
      const remaining = deadline - io.now();
      if (remaining <= 0) return false;
      await io.sleep(Math.min(pollMs, remaining));
      return true;
    },
    /** One line per read that does not settle it: the run log then holds the last classification seen. */
    note(what, detail) {
      if (onPoll) onPoll(`npm visibility ${io.now() - started}ms of ${budgetMs}ms: ${what}${detail ? ` (${detail})` : ''}`);
    },
  };
}

/**
 * Re-read the npm provenance of one version until the registry serves it, within `scope`'s budget (#174).
 *
 * The attestations endpoint answers 404 for two different things this wait must not conflate: the
 * version was published without provenance, and the version was published with provenance but the
 * bundle index has not caught up (v0.2.1: the package answered 200 for over a minute before its
 * attestation did). Waiting on every 404 would spend the budget on a real absence and then downgrade
 * a definite "there is none" to "unknown"; failing on every 404 made promote stop with `missing`
 * right after it had already moved npm latest. So a 404 is only waited on while something shows it
 * can still change:
 *
 *   - the version document declares `dist.attestations` -> the bundle exists; a 404 is index lag.
 *   - the packument's `time` entry is recent            -> nothing could be that old yet.
 *
 * "This run dispatched the publish, so it must be fresh" was considered and rejected: npm-publish.yml
 * treats a failed publish as done when the registry then holds the expected tarball, so a green run
 * does not prove this run's own publish is the one that landed. The publish time is a fact either way,
 * works on a rerun, and is what a reader can check afterwards.
 *
 * A version published longer ago than NPM_PROVENANCE_INDEX_WINDOW_MS, whose document was read and
 * declares no attestation, is not lagging any more: the wait stops at once with `provenance-absent`.
 * An old publish whose document could not be read is *not* that — nothing was read, so it stays
 * `provenance-unconfirmed` instead of asserting an absence and telling a maintainer to re-cut the
 * release. A 200 without a SLSA v1 attestation and a 401/403 are answers that cannot change, and stop
 * at once too.
 *
 * The evidence reads are retried while the endpoint keeps answering 404 and the evidence is still
 * unknown, so one unreadable packument cannot turn a definite absence into an uncertainty; once either
 * value is learned it is kept. `provenance-unconfirmed` therefore means the endpoint never stopped
 * answering 404 *and* the evidence never became readable — never "the evidence read failed once".
 *
 * -> { ok: true, outcome: 'ok', reason: null, waitedMs, budgetMs, reads: { provenance, declaration, publishedAt }, declaration, publishedAt }
 *  | { ok: false, outcome, reason, waitedMs, ... }
 *    outcome ∈ provenance-not-indexed (declared, not served yet)
 *            | provenance-unconfirmed (404, and nothing shows whether an attestation exists)
 *            | provenance-absent     (definitely none: not lagging any more, or the body has no SLSA v1)
 *            | provenance-denied     (401/403: this reader may not see it)
 */
export async function awaitNpmProvenance({ version, io, budgetMs = NPM_VISIBILITY_BUDGET_MS, pollMs = NPM_VISIBILITY_POLL_MS, onPoll, scope = null }) {
  const clock = scope ?? waitScope({ io, budgetMs, pollMs, onPoll });
  const reads = { provenance: 0, declaration: 0, publishedAt: 0 };
  // What the version document last said: true (declares attestations), false (it does not), null (unread).
  let declaration = null;
  // Epoch ms of this version's publish, when the packument could be read.
  let publishedAt = null;
  /**
   * Read the evidence that decides whether a 404 can still change: what the version document declares,
   * and when this version was published. Only called once the endpoint has actually answered 404, so the
   * happy path (provenance served at once) pays for none of it.
   *
   * A read that fails is retried on the next 404 instead of being remembered as "no evidence". Caching
   * that failure was a real hole (CodeRabbit, PR #177): one unreadable packument turned a version that
   * was published days ago and declares no attestation from a definite `provenance-absent` into
   * `provenance-unconfirmed`, which promote treats as waitable and hands to verify as a pending hint —
   * so a release with no provenance at all could be reported complete. Recovering the evidence is what
   * keeps a real absence definite. A value already learned is never re-read.
   */
  const readEvidence = async () => {
    if (declaration === null && io.npmProvenanceDeclared) {
      const declared = await io.npmProvenanceDeclared();
      reads.declaration += 1;
      if (declared?.state === 'ok') declaration = declared.evidence.declared === true;
    }
    // A declared attestation already settles it; there is nothing a publish time would add.
    if (declaration !== true && publishedAt === null && io.npmPublishedAt) {
      const published = await io.npmPublishedAt();
      reads.publishedAt += 1;
      if (published?.state === 'ok') publishedAt = published.evidence.publishedAt;
    }
  };
  const result = (outcome, reason) => ({ ok: outcome === 'ok', outcome, reason, waitedMs: clock.spent(), budgetMs: clock.budgetMs, reads, declaration, publishedAt });
  for (;;) {
    const read = await io.npmProvenance();
    reads.provenance += 1;
    if (read.state === 'ok') return result('ok', null);
    if (read.state === 'missing') {
      // A 200 whose body carries no SLSA v1 attestation is the registry's answer, not an index delay.
      return result(PROVENANCE_ABSENT, `${read.detail}; the registry answered, so this is not a delay`);
    }
    if (read.state === 'unknown') {
      // A denial or an answer of the wrong shape will not change: waiting cannot make it readable.
      if (read.definitive === true || read.evidence?.definitive === true) {
        return result(PROVENANCE_DENIED, `npm provenance cannot be read (${read.detail ?? 'unknown'}); the registry gave a definitive answer, so this is not a delay`);
      }
      clock.note('provenance unreadable', read.detail);
      if (!(await clock.more())) {
        return result(PROVENANCE_UNCONFIRMED, `npm provenance stayed unreadable for ${clock.spent()}ms (${read.detail ?? 'unknown'}); whether ${version} has provenance is unknown`);
      }
      continue;
    }
    // Pending: the endpoint answered 404. Decide whether that can still change.
    await readEvidence();
    const age = publishedAt === null ? null : io.now() - publishedAt;
    // A definite absence needs the document to have been *read* and to carry no attestation. An old
    // publish alone is not enough: if the document was unreadable, calling this absent would assert a
    // fact nobody read, stop the run, and tell the maintainer to cut a new tag for a gap that may not
    // exist (CodeRabbit, PR #177). `declaration === null` stays an uncertainty.
    if (declaration === false && age !== null && age > NPM_PROVENANCE_INDEX_WINDOW_MS) {
      return result(PROVENANCE_ABSENT, `npm has no provenance for ${version}: its version document was read and declares none, and it was published ${age}ms ago, longer than any index delay`);
    }
    clock.note('provenance not indexed yet', declaration === true ? 'the version document declares it' : read.detail);
    if (!(await clock.more())) {
      if (declaration === true) {
        return result(PROVENANCE_NOT_INDEXED, `the registry declares provenance for ${version} but has not served it after ${clock.spent()}ms; the attestation exists and its index has not caught up`);
      }
      // What was actually established decides the wording: "declares none" only after reading it.
      const read = declaration === false ? 'and its version document declares none' : 'and its version document could not be read';
      // Published within the window, or the publish time could not be read: either way it may still land.
      const fresh = age !== null && age <= NPM_PROVENANCE_INDEX_WINDOW_MS;
      return result(
        fresh ? PROVENANCE_NOT_INDEXED : PROVENANCE_UNCONFIRMED,
        fresh
          ? `the registry has not served provenance for ${version} after ${clock.spent()}ms ${read}; it was published ${age}ms ago, so its index may still catch up`
          : `the registry still answers 404 for provenance of ${version} after ${clock.spent()}ms ${read}; whether an attestation exists is unconfirmed`,
      );
    }
  }
}

/**
 * Re-read npm within one budget until the exact version, its channel pointer and its provenance are
 * all settled. Nothing here is written; nothing is published.
 *
 * This only reads. It never dispatches npm-publish again and never publishes, so a rerun of promote stays
 * the only thing that can write. What may wait is exactly what a registry index delay can explain: the
 * exact version answering 404, a transient read failure, a channel pointer still absent or on an older
 * version, and — since #174 — a provenance 404 that the signals below cannot rule out as lag. What must
 * not wait: a tarball with another integrity, an answer the reader may not see (401/403), an answer it
 * cannot interpret, and a prerelease `next` already past this version.
 *
 * The tag side has only ok/missing/unknown (registry-read's own vocabulary). An unknown that is a read
 * failure is re-read like an absent pointer; one marked definitive (denial, or an answer of the wrong shape)
 * stops at once. Once the budget is spent an unknown is reported as unknown, never as "not written", and a
 * package that is visible with a pointer that never moved is reported as that, not as "not written" either.
 *
 * The result always carries `provenance`. `ok` covers the package and its channel pointer; the caller
 * decides what to do with the provenance, because that decision differs by outcome: a waitable
 * `provenance-not-indexed` / `provenance-unconfirmed` continues (stopping on one after npm latest already
 * moved is exactly the partial window #174 is about), and a definite `provenance-absent` /
 * `provenance-denied` stops — but with npm latest already moved, so the caller must still report that.
 *
 * -> { ok: true, pointer, maintenance, waitedMs, budgetMs, reads: { package, tag, provenance }, provenance }
 *  | { ok: false, outcome, reason, waitedMs, budgetMs, reads: { package, tag, provenance }, last? }
 *    outcome ∈ not-visible | unknown | tag-not-confirmed | tag-moved | tag-unknown
 */
export async function awaitNpmVisibility({ version, prerelease, expectedIntegrity, io, budgetMs = NPM_VISIBILITY_BUDGET_MS, pollMs = NPM_VISIBILITY_POLL_MS, onPoll }) {
  const clock = waitScope({ io, budgetMs, pollMs, onPoll });
  const reads = { package: 0, tag: 0, provenance: 0 };
  const stop = (outcome, reason, last) => ({ ok: false, outcome, reason, waitedMs: clock.spent(), budgetMs, reads, ...(last ? { last } : {}) });
  const name = prerelease ? 'npm next' : 'npm latest';
  /**
   * The version and its channel are served. The provenance has to be settled before final verify is
   * asked: a lagging bundle index there is what stopped v0.2.1's first promote after npm latest moved.
   */
  const withProvenance = async (pointer, maintenance) => {
    const provenance = await awaitNpmProvenance({ version, io, onPoll, scope: clock });
    reads.provenance = provenance.reads.provenance;
    // `ok` is about the package and its channel pointer only: those are visible. The provenance is its
    // own field, because a definite gap must still be reported after npm latest has moved (the caller
    // stopped *because of provenance*, not because npm was missing) — see promote()'s npm step.
    return { ok: true, pointer, maintenance, waitedMs: clock.spent(), budgetMs, reads, provenance };
  };
  let last;
  for (;;) {
    last = await io.npmState({ expectedIntegrity });
    reads.package += 1;
    if (last.state === 'same') break;
    if (last.state === 'different' || last.state === 'denied' || last.state === 'untrusted') {
      return stop(last.state, `${last.detail}; the registry gave a definitive answer, not an index delay`, last);
    }
    clock.note(`package ${last.state}`, last.detail);
    if (!(await clock.more())) {
      return last.state === 'absent'
        ? stop(NOT_VISIBLE, `the registry still answers 404 for ${version} after ${clock.spent()}ms; confirmed not written`, last)
        : stop(UNKNOWN, `the registry stayed unreadable for ${clock.spent()}ms (${last.detail}); whether ${version} is published is unknown`, last);
    }
  }
  // The package is visible. The channel pointer is what a promotion claims, so it has to be visible too.
  for (;;) {
    const pointers = await io.npmPointers();
    const pointer = prerelease ? pointers.next : pointers.latest;
    reads.tag += 1;
    if (pointer.state === 'version' && pointer.version === version) return withProvenance(pointer, false);
    if (pointer.state === 'version' && prerelease && !shouldMoveLatest(pointer.version, version)) {
      // `next` past this version is a contradiction, not a lag: something moved it. An older `next` is the
      // index delay this wait exists for, so it falls through and is re-read like an absent pointer.
      return stop('tag-moved', `${name} is ${pointer.version}, newer than ${version}; that is not a visibility delay`, pointer);
    }
    if (pointer.state === 'version' && !shouldMoveLatest(pointer.version, version)) {
      // A newer stable pointer is maintenance, not a delay: this version was published beside it.
      return withProvenance(pointer, true);
    }
    if (pointer.state === 'unknown' && pointer.definitive === true) {
      // A denial or an answer of the wrong shape will not change: waiting cannot make it readable.
      return stop('tag-unknown', `${name} cannot be read (${pointer.detail ?? 'unknown'}); the registry gave a definitive answer, so this is not an index delay`, pointer);
    }
    clock.note(`${name} ${pointer.version ?? pointer.state}`, pointer.detail);
    if (!(await clock.more())) {
      return pointer.state === 'unknown'
        ? stop('tag-unknown', `${name} still cannot be read after ${clock.spent()}ms (${pointer.detail ?? 'unknown'}); whether it points at ${version} is unknown`, pointer)
        : stop(TAG_NOT_CONFIRMED, `${name} still reads ${pointer.version ?? pointer.state} after ${clock.spent()}ms; the package is published, but ${name} did not move to ${version}`, pointer);
    }
  }
}

/**
 * The provenance hint a candidate preflight needs, or null.
 *
 * `verify-release --stage candidate` allows npm to be absent, so it only compares provenance when the
 * version is already published — which on a rerun is the version a previous promote published moments
 * ago. Reading it strictly there is the same trap #174 is about one stage earlier: the rerun that exists
 * to finish the promotion would fail on the index delay it was meant to wait for. So this settles the
 * provenance first, inside the same bounded wait, and hands the stage a `pending` hint.
 *
 * Returns `{ hint, provenance }`. `hint` is null when npm is not published (nothing to compare), or when
 * the provenance was read. A definite gap is *not* hinted: the candidate stage then reports the 404 it
 * really is.
 */
async function candidateProvenance({ version, expectedIntegrity, io }) {
  const state = await io.npmState({ expectedIntegrity });
  if (state.state !== 'same') return { hint: null, provenance: null };
  const provenance = await awaitNpmProvenance({ version, io, onPoll: io.log ? (line) => io.log(`${line}\n`) : undefined });
  const waitable = PROVENANCE_WAITABLE.includes(provenance.outcome);
  return { hint: waitable ? { state: 'pending', detail: provenance.reason } : null, provenance };
}

/**
 * @param {object} options
 * @param {string} options.version  x.y.z or x.y.z-pre.n, already matching options.tag
 * @param {string} options.tag      v<version>
 * @param {string} options.commit   the tag commit resolved once at the start; every write re-checks it
 * @param {object} options.io       { expectedIntegrity, verify, npmState, npmPointers, npmProvenance,
 *                                    npmProvenanceDeclared, npmPublishedAt, sleep, now, dispatchNpm, waitNpm,
 *                                    readPointers, moveGhcrLatest, releaseState, publishRelease, verifyRemoteTag }
 *   `npmState` answers with a classified read (`state` plus `detail`), not a bare string. The three
 *   provenance readers are optional: without them a provenance 404 is waited on only while it is
 *   recent, which is the conservative half of the same rule.
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
  // How a publish of this run ended against the registry: confirmed visible, confirmed not written,
  // published but its channel pointer unconfirmed, or unknown.
  let npmAfterPublish = null;
  // The last npm provenance settle of this run, from the visibility wait or from a rerun's own read.
  // It is what final verify is told about a 404 there (#174).
  let provenance = null;
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

    // A rerun finds npm already published, and this stage compares its provenance (#174): settle it first
    // so the step that exists to finish the promotion cannot fail on the index delay it was meant to wait for.
    const beforeCandidate = await step('npm provenance before the candidate preflight', () => candidateProvenance({ version, expectedIntegrity, io }));
    provenance = beforeCandidate.provenance;
    if (provenance) await record(`npm ${version}: ${provenanceNote(provenance)}`);
    const candidate = await step('candidate preflight', () => io.verify({ stage: 'candidate', expectedIntegrity, ...(beforeCandidate.hint ? { provenanceIndex: beforeCandidate.hint } : {}) }));
    if (candidate.exitCode !== 0) throw new PromoteStop(`candidate preflight is ${candidate.overall}; see the report above`);
    await record('candidate preflight: complete');

    // npm: absent -> dispatch and wait; same -> already published; different -> refuse.
    const npmName = prerelease ? 'npm next' : 'npm latest';
    const readBefore = await step('npm state', () => io.npmState({ expectedIntegrity }));
    const npmBefore = readBefore.state;
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
      // Only when the pre-candidate read found npm unpublished (so it settled nothing) is this a fresh
      // settle. An answer that already waited out the budget stands: waiting again would spend a second
      // one on the same question, and the issue asks for provenance to share one budget, not to double it.
      if (!provenance) {
        provenance = await step('npm provenance', () => awaitNpmProvenance({ version, io, onPoll: io.log ? (line) => io.log(`${line}\n`) : undefined }));
        await record(`npm ${version}: ${provenanceNote(provenance)}`);
      }
      // Nothing was published by this run, so a definite gap stops cleanly here with a message that names
      // the version and what a maintainer would have to do; final verify would only repeat it as `missing`.
      if (DEFINITE_PROVENANCE.has(provenance.outcome)) {
        throw new PromoteStop(`npm provenance is a definite gap: ${provenance.reason}. ${PROVENANCE_FIX}`);
      }
    } else if (npmBefore === 'absent') {
      const pointers = await step('read npm dist-tags', () => io.readPointers());
      const decision = pointerDecisions(pointers, version, prerelease)[npmName];
      if (decision === 'unknown') throw new PromoteStop(`${npmName} cannot be read before publishing`);
      // npm-publish sends an older stable to maintenance; an older prerelease has no such tag, so refuse it.
      if (prerelease && decision === 'keep') throw new PromoteStop(`npm next is ${pointers.npm.next.version}, newer than ${version}; publishing would move next backwards`);
      const before = prerelease ? pointers.npm.next : pointers.npm.latest;
      await guardTag();
      const published = async () => (await io.npmState({ expectedIntegrity })).state === 'same';
      const run = await write('npm publish run', async () => {
        const dispatched = await io.dispatchNpm({ tag, commit, expectedIntegrity });
        await io.waitNpm(dispatched);
        return dispatched;
      }, published);
      // The publish run exiting 0 does not mean the registry serves the version yet (v0.2.0 stopped here
      // after ~18s). Re-read within one budget, and record which of three states the budget ended on.
      const visibility = await step('npm visibility after publish', () => awaitNpmVisibility({
        version, prerelease, expectedIntegrity, io,
        onPoll: io.log ? (line) => io.log(`${line}\n`) : undefined,
      }));
      provenance = visibility.provenance ?? null;
      const by = run ? ` by run ${run.id ?? run}` : '';
      const waited = visibility.waitedMs > 0 ? ` after ${visibility.waitedMs}ms` : '';
      const provenanceAfterPublish = provenanceNote(visibility.provenance);
      npmAfterPublish = visibility.ok
        ? visibility.maintenance
          ? `confirmed visible${waited}; ${npmName} stays ${visibility.pointer.version} (maintenance); ${provenanceAfterPublish}`
          : `confirmed visible${waited}; ${provenanceAfterPublish}`
        : visibility.outcome === 'not-visible'
          ? `not written — ${visibility.reason}`
          : visibility.outcome === TAG_NOT_CONFIRMED
            ? `published; channel pointer unconfirmed — ${visibility.reason}`
            : visibility.outcome === 'unknown' || visibility.outcome === 'tag-unknown'
              ? `unknown — ${visibility.reason}`
              : `${visibility.outcome} — ${visibility.reason}`;
      if (!visibility.ok) {
        throw new PromoteStop(`npm publish run finished but the registry does not confirm ${version}: ${visibility.reason}`);
      }
      if (decision === 'keep' && visibility.pointer.version === version) {
        // The pointer was newer before the dispatch: a publish that took it is a backwards move, not a promotion.
        throw new PromoteStop(`${npmName} moved backwards from ${before.version} to ${version}; a maintainer restores it with npm dist-tag add @nema-project/nema@${before.version} ${prerelease ? 'next' : 'latest'}`);
      }
      if (visibility.maintenance) {
        // Only an explicitly newer latest explains a stable publish that left latest alone (maintenance).
        await record(`npm ${version}: published${by} under maintenance; ${npmName} stays ${visibility.pointer.version}; ${provenanceAfterPublish}`);
      } else {
        flipped.push(npmName);
        await record(`npm ${version}: published${by}; ${npmName} -> ${version}${waited}; ${provenanceAfterPublish}`);
      }
      // A provenance the registry definitively lacks stops here. npm latest already moved, so this is said
      // plainly rather than as "the package was not published".
      if (provenance && DEFINITE_PROVENANCE.has(provenance.outcome)) {
        throw new PromoteStop(`npm provenance is a definite gap: ${provenance.reason}. ${PROVENANCE_FIX}`);
      }
    } else {
      throw new PromoteStop(`cannot tell whether ${version} is already on npm: ${readBefore.detail ?? npmBefore}`);
    }

    // A provenance item this run could not settle, but which nothing shows to be absent, must not fail
    // final verify: that is a waitable item, and stopping on it after npm latest already moved is exactly
    // the partial window #174 is about. Final verify is told, so it reports it apart from a real gap.
    const provenanceIndex = provenance && PROVENANCE_WAITABLE.includes(provenance.outcome) ? { state: 'pending', detail: provenance.reason } : null;
    const final = await step('final verify', () => io.verify({ stage: 'final', ...(provenanceIndex ? { provenanceIndex } : {}) }));
    if (final.exitCode !== 0) throw new PromoteStop(`final verify is ${final.overall}; see the report above`);
    await record('final verify: complete');
    if (provenanceIndex) await record(`npm provenance: still a waitable item, not a gap — ${provenance.reason}. ${WAITABLE_RERUN}`);

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
    if (npmAfterPublish) await summary(`- npm registry after publish: ${npmAfterPublish}`);
    if (provenance && !provenance.ok) {
      const kind = DEFINITE_PROVENANCE.has(provenance.outcome) ? `a definite gap (${provenance.outcome})` : `a waitable item (${provenance.outcome})`;
      await summary(`- npm provenance: ${kind} — ${provenance.reason}`);
    }
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
  ...[1, 2, 3, 4, 5, 6].map((shard) => `verify / Application tests (${shard}/6)`),
  'verify / Application build and Compose smoke',
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
    async verify({ stage, expectedIntegrity, provenanceIndex }) {
      const report = await verifyRelease({ version, stage, expectedIntegrity, io: readIo, provenanceIndex });
      log(`${JSON.stringify({ stage, overall: report.overall, items: Object.fromEntries(Object.entries(report.items).map(([key, item]) => [key, `${item.state}: ${item.detail}`])) }, null, 2)}\n`);
      return report;
    },
    // One classified read: the caller decides whether a non-definitive answer is worth another look.
    npmState: ({ expectedIntegrity }) => probeNpmVersion({ version, expectedIntegrity, fetchImpl }),
    npmPointers: () => npmPointers(readIo),
    // A 404 here is `pending`, never `missing`: only this wait is allowed to decide whether a 404 is a lag.
    npmProvenance: () => readNpmProvenance(readIo, version, { when404: 'pending' }),
    npmProvenanceDeclared: () => npmProvenanceDeclared(readIo, version),
    npmPublishedAt: () => readNpmPublishedAt(readIo, version),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
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
  // Same reasoning as promote's own candidate step: a rerun's preflight is the first thing to read the
  // provenance of the version a previous promote just published (#174).
  const { hint, provenance } = await candidateProvenance({ version, expectedIntegrity, io });
  if (provenance) process.stdout.write(`npm ${version}: ${provenanceNote(provenance)}\n`);
  const report = await io.verify({ stage: 'candidate', expectedIntegrity, ...(hint ? { provenanceIndex: hint } : {}) });
  return { ok: report.exitCode === 0, overall: report.overall, expectedIntegrity, provenance };
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
