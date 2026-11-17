import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { assertMultiarchManifest } from './check-images.mjs';

const workflow = parse(readFileSync(new URL('../../.github/workflows/image-publish.yml', import.meta.url), 'utf8'));
const matrix = [
  { arch: 'amd64', runner: 'ubuntu-24.04' },
  { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
];

test('both architectures build and smoke on native runners with separate artifacts', () => {
  for (const name of ['build', 'smoke']) {
    const job = workflow.jobs[name];
    assert.deepEqual(job.strategy.matrix.include, matrix);
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job['runs-on'], '${{ matrix.runner }}');
    assert.match(job.name, /\(\$\{\{ matrix.arch \}\}\)/);
    const text = job.steps.map((step) => step.run ?? '').join('\n');
    assert.match(text, /docker image inspect.*Architecture/);
    assert.match(text, /uname -m/);
  }
  const build = workflow.jobs.build;
  assert.equal(build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@')).with.name, 'nema-image-layouts-${{ matrix.arch }}');
  const text = build.steps.map((step) => step.run ?? '').join('\n');
  assert.match(text, /--platform "linux\/\$ARCH"/);
  assert.match(text, /skopeo copy.*oci-archive:.*docker-daemon:/);
  assert.doesNotMatch(text, /qemu|Linux_x86_64/);
});

test('serialized publisher assembles digest sources and rechecks the tag before each write', () => {
  const job = workflow.jobs.publish;
  assert.equal(job.concurrency.group, 'image-publish-registry');
  const step = job.steps.find((step) => step.name === 'Push the verified layouts');
  assert.match(step.run, /for arch in amd64 arm64/);
  assert.match(step.run, /verify-remote[^\n]*\n\s*"\$RUNNER_TEMP\/crane" push/);
  assert.match(step.run, /digest.*\$\{VERSION\}-\$\{arch\}/);
  assert.match(step.run, /sources\+=\("\$\{image\}@\$\{digest\}"\)/);
  assert.match(step.run, /verify-remote[^\n]*\n\s*docker buildx imagetools create/);
  assert.match(step.run, /imagetools create --tag "\$\{image\}:\$\{VERSION\}" "\$\{sources\[@\]\}"/);
  assert.match(step.run, /check-images.mjs --registry/);
  assert.doesNotMatch(step.run, /\blatest\b/);
});

test('manifest assertions accept OCI and Docker lists and reject ambiguous platform coverage', () => {
  const entries = ['amd64', 'arm64'].map((architecture, n) => ({
    mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${String(n + 1).repeat(64)}`,
    platform: { os: 'linux', architecture },
  }));
  for (const mediaType of ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']) {
    const manifest = { schemaVersion: 2, mediaType, manifests: entries };
    assert.doesNotThrow(() => assertMultiarchManifest(manifest));
    assert.throws(() => assertMultiarchManifest({ ...manifest, manifests: entries.slice(0, 1) }), /linux\/arm64/);
    assert.throws(() => assertMultiarchManifest({ ...manifest, manifests: [...entries, entries[1]] }), /linux\/arm64/);
    assert.doesNotThrow(() => assertMultiarchManifest({ ...manifest, manifests: [...entries, { platform: { os: 'unknown', architecture: 'unknown' } }] }));
  }
  assert.throws(() => assertMultiarchManifest({ schemaVersion: 2, config: {} }), /index/);
});

test('publisher unwraps the OCI layout envelope before combining platform indices', () => {
  const text = workflow.jobs.publish.steps.find((step) => step.name === 'Push the verified layouts').run;
  assert.match(text, /check-images.mjs --flatten-layout "\$layout"/);
  assert.ok(text.indexOf('--flatten-layout') < text.indexOf('push --index'));
});

test('OCI envelope removal preserves runnable and attestation descriptors and all blobs', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { flattenOciLayout } = await import('./check-images.mjs');
  const root = await mkdtemp(join(tmpdir(), 'nema-index-'));
  try {
    const digest = 'a'.repeat(64);
    await mkdir(join(root, 'blobs', 'sha256'), { recursive: true });
    const child = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
      { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
      { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ] };
    const envelope = { ...child, manifests: [{ mediaType: child.mediaType, digest: `sha256:${digest}` }] };
    const blob = JSON.stringify(child);
    await writeFile(join(root, 'index.json'), JSON.stringify(envelope));
    await writeFile(join(root, 'blobs', 'sha256', digest), blob);
    await flattenOciLayout(root);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')), child);
    assert.equal(await readFile(join(root, 'blobs', 'sha256', digest), 'utf8'), blob);
    await flattenOciLayout(root);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')), child, 'already-flat layouts are idempotent');
    await writeFile(join(root, 'index.json'), JSON.stringify({ ...envelope, manifests: [...envelope.manifests, ...envelope.manifests] }));
    await assert.rejects(flattenOciLayout(root), /Ambiguous/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication shell stops on tag or push failure and assembles only the recorded digests', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'nema-publish-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const scripts = {
      git: 'echo commit',
      tar: 'exit 0',
      node: `
        case "$*" in
          *--verify-remote*) echo verify >> "$CALLS"; test "\${FAIL_AT:-}" != tag ;;
          *) echo "check $*" >> "$CALLS" ;;
        esac`,
      crane: `
        echo "crane $*" >> "$CALLS"
        if [ "$1" = digest ]; then
          case "$2" in *-amd64) printf 'sha256:%064d\\n' 1 ;; *) printf 'sha256:%064d\\n' 2 ;; esac
        elif [ "\${FAIL_AT:-}" = web ] && echo "$*" | grep -q nema-room-web; then exit 1; fi`,
      docker: 'echo "assemble $*" >> "$CALLS"',
    };
    for (const [name, body] of Object.entries(scripts)) await writeFile(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
    const step = workflow.jobs.publish.steps.find((item) => item.name === 'Push the verified layouts');
    for (const fail of ['', 'tag', 'web']) {
      const calls = join(root, `calls-${fail || 'ok'}`);
      await writeFile(calls, '');
      const result = spawnSync('bash', ['-c', step.run], { cwd: root, encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: bin, CALLS: calls, FAIL_AT: fail,
        GITHUB_SHA: 'commit', RELEASE_COMMIT: 'commit', TAG: 'v0.2.7', VERSION: '0.2.7',
      } });
      assert.ifError(result.error);
      const log = (await readFile(calls, 'utf8')).trim().split('\n');
      assert.equal(result.status === 0, !fail, result.stderr);
      const writes = log.filter((line) => line.startsWith('crane push') || line.startsWith('assemble'));
      if (fail === 'tag') assert.deepEqual(writes, []);
      else {
        assert.equal(writes.filter((line) => line.startsWith('assemble')).length, fail ? 1 : 2);
        for (const line of writes) assert.equal(log[log.indexOf(line) - 1], 'verify', line);
        for (const assembly of writes.filter((line) => line.startsWith('assemble'))) {
          assert.match(assembly, /@sha256:0{63}1 .*@sha256:0{63}2$/);
          assert.doesNotMatch(assembly, /latest/);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
