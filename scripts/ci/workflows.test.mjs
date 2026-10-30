import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { classifyPaths } from './policy.mjs';
import { REQUIRED_PUSH_JOBS, REQUIRED_TAG_RUN_JOBS, VERIFY_JOBS } from '../release/promote.mjs';
const read = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const checkout = job => job.steps.filter(s => s.uses?.startsWith('actions/checkout@'));
const expr = value => value?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();

function assertCi(ci) {
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.ok(Object.hasOwn(ci.on, 'workflow_dispatch'));
  assert.deepEqual(ci.on.push?.branches, ['main']);
  for (const trigger of [ci.on.pull_request, ci.on.push, ci.on.workflow_dispatch]) {
    assert.equal(trigger?.paths, undefined);
    assert.equal(trigger?.['paths-ignore'], undefined);
  }
  assert.equal(ci.on.pull_request_target, undefined);
  assert.equal(ci.on.merge_group, undefined);
  assert.equal(ci.concurrency.group, 'ci-${{ github.ref }}');
  assert.equal(expr(ci.concurrency['cancel-in-progress']), "github.event_name == 'pull_request'");
  assert.equal(ci.permissions.contents, 'read');
  assert.equal(ci.jobs.gate.name, 'CI gate');
  assert.equal(expr(ci.jobs.gate.if), 'always()');
  assert.deepEqual([...ci.jobs.gate.needs].sort(), ['classify','docs','verify']);
  assert.equal(ci.jobs.verify.uses, './.github/workflows/verify.yml');
  assert.equal(expr(ci.jobs.verify.with.checkout_ref), 'github.sha');
  assert.equal(ci.jobs.verify.secrets, undefined);
  assert.equal(expr(ci.jobs.verify.if), "needs.classify.result == 'success'");
  assert.equal(expr(ci.jobs.verify.with.app_tests), "needs.classify.outputs.mode != 'docs'");
  assert.equal(expr(ci.jobs.verify.with.platform), "needs.classify.outputs.mode == 'full' || needs.classify.outputs.platform == 'true'");
  assert.equal(expr(ci.jobs.verify.with.npm_pack), "needs.classify.outputs.mode == 'full' || needs.classify.outputs.npm_pack == 'true'");
  const outputs = ci.jobs.classify.outputs;
  assert.equal(expr(outputs.mode), 'steps.changes.outputs.mode');
  assert.equal(expr(outputs.platform), 'steps.changes.outputs.platform');
  assert.equal(expr(outputs.npm_pack), 'steps.changes.outputs.npm_pack');
  const changes = ci.jobs.classify.steps.find(s => s.id === 'changes');
  assert.ok(changes);
  assert.equal(expr(changes.env.BASE), 'github.event.pull_request.base.sha');
  assert.equal(expr(changes.env.HEAD), 'github.sha');
  const fullBranch = changes.run.slice(0, changes.run.indexOf('changes.mjs'));
  assert.match(fullBranch, /workflow_dispatch/);
  assert.match(fullBranch, /"\$EVENT" = "push"/);
  for (const line of ['mode=full', 'platform=true', 'npm_pack=true', 'desktop=false', 'image=false', 'README.md', 'scripts/desktop/RELEASE.md']) {
    assert.ok(fullBranch.includes(line), line);
  }
  const step = ci.jobs.gate.steps.find(s => s.run === 'node scripts/ci/policy.mjs');
  assert.ok(step);
  for (const [key,value] of Object.entries({
    MODE:'needs.classify.outputs.mode',
    CLASSIFY:'needs.classify.result',
    DOCS:'needs.docs.result',
    LINT:'needs.verify.outputs.lint',
    APP:'needs.verify.outputs.app',
    PLATFORM:'needs.verify.outputs.platform',
    NPM_PACK:'needs.verify.outputs.npm_pack',
    PLATFORM_REQUIRED:'needs.classify.outputs.platform',
    NPM_PACK_REQUIRED:'needs.classify.outputs.npm_pack',
  })) assert.equal(expr(step.env[key]), value);
  return step;
}

test('PR gate runs for every PR and forwards actual dependency results to the policy', () => {
  const release = read('desktop-release');
  assert.match(expr(release.concurrency['cancel-in-progress']), /!startsWith\(github\.ref, 'refs\/tags\/'\)/);
  const ci = read('ci'); const step = assertCi(ci);
  const fullEnv = {MODE:'full', CLASSIFY:'success', DOCS:'success', LINT:'success', APP:'success', PLATFORM:'success', NPM_PACK:'success', PLATFORM_REQUIRED:'true', NPM_PACK_REQUIRED:'true'};
  for (const app of ['success','failure','cancelled','skipped','']) {
    const run = spawnSync(process.execPath, ['scripts/ci/policy.mjs'], {env:{...process.env, ...fullEnv, APP:app}});
    assert.equal(run.status, app === 'success' ? 0 : 1);
  }
  const mutation = structuredClone(ci);
  mutation.jobs.gate.steps.find(s => s.run === step.run).env.PLATFORM_REQUIRED = 'true';
  assert.throws(() => assertCi(mutation));
  const skipped = structuredClone(ci); skipped.jobs.gate.if = 'success()';
  assert.throws(() => assertCi(skipped));
});

test('missing heavy-job flags fail the gate', () => {
  const base = {MODE:'app', CLASSIFY:'success', DOCS:'success', LINT:'success', APP:'success', PLATFORM:'skipped', NPM_PACK:'skipped', NPM_PACK_REQUIRED:'false'};
  const run = (extra) => {
    const env = {...process.env, ...base};
    delete env.PLATFORM_REQUIRED;
    Object.assign(env, extra);
    return spawnSync(process.execPath, ['scripts/ci/policy.mjs'], {env});
  };
  assert.equal(run({}).status, 1);
  assert.equal(run({PLATFORM_REQUIRED:''}).status, 1);
  assert.equal(run({PLATFORM_REQUIRED:'false'}).status, 0);
  assert.equal(run({PLATFORM_REQUIRED:'true'}).status, 1);
});

test('reusable verification checks the supplied ref with the complete existing suite', () => {
  const verify = read('verify');
  const inputs = verify.on.workflow_call.inputs;
  assert.deepEqual(inputs.checkout_ref, {required:true, type:'string'});
  for (const name of ['app_tests', 'platform', 'npm_pack']) {
    assert.equal(inputs[name].type, 'boolean', name);
    assert.equal(inputs[name].default, true, name);
    assert.notEqual(inputs[name].required, true, name);
  }
  assert.equal(verify.permissions.contents, 'read');
  const jobIf = {'workflow-lint': undefined, test: 'inputs.app_tests', platform: 'inputs.platform', 'npm-pack': 'inputs.npm_pack'};
  for (const [name, job] of Object.entries(verify.jobs)) {
    assert.equal(expr(job.if), jobIf[name], name);
    assert.equal(job['continue-on-error'], undefined);
    for (const step of checkout(job)) {
      assert.equal(expr(step.with.ref), 'inputs.checkout_ref');
      assert.equal(step.with['persist-credentials'], false);
    }
  }
  const outputs = verify.on.workflow_call.outputs;
  assert.equal(expr(outputs.lint.value), 'jobs.workflow-lint.result');
  assert.equal(expr(outputs.app.value), 'jobs.test.result');
  assert.equal(expr(outputs.platform.value), 'jobs.platform.result');
  assert.equal(expr(outputs.npm_pack.value), 'jobs.npm-pack.result');
  for (const name of ['npm-publish', 'desktop-release', 'image-publish']) {
    const caller = read(name).jobs.verify.with;
    for (const key of ['app_tests', 'platform', 'npm_pack']) assert.notEqual(caller[key], false, `${name} ${key}`);
  }
  assert.deepEqual(verify.jobs.platform.strategy.matrix.os, ['macos-latest','windows-latest']);
  assert.ok(verify.jobs.platform.steps.some((step) => step.run === 'npx vitest run apps/hub/test/upgradeRecovery.test.ts apps/local/test/semanticAcceptance.test.ts --maxWorkers=1'));
  assert.ok(verify.jobs.platform.steps.some((step) => step.run === 'node --test scripts/security/reporting-status.test.mjs'));
  assert.ok(verify.jobs.test.steps.some((step) => step.run === 'node --test scripts/security/reporting-status.test.mjs'));
  assert.ok(verify.jobs.test.steps.some((step) => (step.run ?? '').includes('scripts/release/*.test.mjs')));
  const runs = verify.jobs.test.steps.map(s => s.run);
  for (const command of ['npm ci','npm run typecheck','npm test -- --maxWorkers=2','npm run build -w apps/hub','npm run build -w apps/cli','npm run lint -w apps/web','npm run build -w apps/web','npm run setup:check','npm run up','docker compose down']) assert.ok(runs.includes(command), command);
  assert.ok(runs.indexOf('npm run typecheck') < runs.indexOf('npm test -- --maxWorkers=2'));
  assert.equal(verify.jobs.test.steps.find(s => s.run === 'docker compose down').if, 'always()');
  const pack = verify.jobs['npm-pack'];
  assert.deepEqual(pack.strategy.matrix.os, ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  const packRuns = pack.steps.map((step) => step.run ?? '').join('\n');
  assert.match(packRuns, /npm ci/);
  assert.match(packRuns, /npm run cli:pack/);
  assert.match(packRuns, /nema-project-nema-\*\.tgz/);
  assert.doesNotMatch(packRuns, /-name 'nema-\*\.tgz'/);
  assert.match(packRuns, /scripts\/npm\/smoke-pack\.mjs/);
  const hub = pack.steps.find((step) => step.name === 'Prepare local hub and daemon token');
  assert.equal(hub.if, "runner.os == 'Linux'");
  assert.match(hub.run, /NEMA_DATA_DIR/);
  assert.match(hub.run, /daemon-token|nema-data/);
  const daemon = pack.steps.find((step) => step.name === 'Smoke daemon against the hub');
  assert.match(daemon.run, /--hub-url/);
  assert.match(daemon.run, /--token-file/);
  assert.match(daemon.run, /--expect-skew/);
  assert.equal((daemon.run.match(/smoke-pack\.mjs/g) ?? []).length, 2);
});

// Evaluate the small Actions boolean expression subset used by these job gates.
function condition(value, context) {
  let source = expr(value);
  source = source.replace(/always\(\)/g, 'true').replace(/cancelled\(\)/g, 'false');
  source = source.replace(/needs\.[\w.]+|github\.(?:event_name|ref_type|ref)\b|inputs\.\w+/g, key => JSON.stringify(key.split('.').reduce((v,k) => v?.[k], context) ?? ''));
  assert.match(source, /^[\s\w'"!&|=().\/-]+$/);
  return Function(`"use strict"; return (${source});`)();
}
function assertRelease(release) {
  const {plan,verify,build,publish} = release.jobs;
  assert.equal(release.on.workflow_dispatch.inputs.verify_full.default, false);
  assert.equal(verify.uses, './.github/workflows/verify.yml');
  assert.equal(expr(verify.with.checkout_ref), 'needs.plan.outputs.commit');
  assert.ok(plan.outputs.commit); assert.ok(plan.outputs.verification_required);
  assert.deepEqual([...build.needs].sort(), ['plan','verify']);
  assert.deepEqual([...publish.needs].sort(), ['build','plan','verify']);
  for (const job of [build,publish]) for (const step of checkout(job)) assert.equal(expr(step.with.ref), 'needs.plan.outputs.commit');
  for (const required of ['true','false']) for (const result of ['success','failure','cancelled','skipped','']) {
    const context = {github:{event_name:'push'}, needs:{plan:{result:'success',outputs:{release:required,verification_required:required}}, verify:{result},build:{result:'success'}}};
    assert.equal(condition(build.if,context), result === 'success' || (required === 'false' && result === 'skipped'), `build ${required}/${result}`);
    assert.equal(condition(publish.if,context), required === 'true' && result === 'success', `publish ${required}/${result}`);
    context.github.event_name='workflow_dispatch';
    assert.equal(condition(publish.if,context), false, 'manual dispatch never publishes, even on a tag');
  }
  for (const failed of ['plan','build']) {
    const context={github:{event_name:'push'},needs:{plan:{result:'success',outputs:{release:'true',verification_required:'true'}},verify:{result:'success'},build:{result:'success'}}};
    for(const result of ['failure','cancelled','skipped','']) { context.needs[failed].result=result; assert.equal(condition(publish.if,context),false); }
  }
}

test('npm publishes only when release-promote dispatches the tag, from the push run tarball', () => {
  const workflow = read('npm-publish');
  const source = readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.equal(source.includes('NPM_TOKEN'), false);
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ['expected_integrity', 'promote_run_id']);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.workflow_call, undefined);
  const { verify, build, publish } = workflow.jobs;
  assert.equal(verify.uses, './.github/workflows/verify.yml');
  assert.equal(expr(verify.with.checkout_ref), 'github.sha');
  assert.equal(build.permissions['id-token'], undefined);
  assert.equal(build.permissions.contents, 'read');
  assert.equal(expr(checkout(build)[0].with.ref), 'github.sha');
  const upload = build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(upload.with.path, /scripts\/release\/npm-state\.mjs/);
  // push and a plain dispatch verify, pack and smoke; a promote dispatch skips both and repacks nothing.
  for (const job of [verify, build]) {
    assert.equal(condition(job.if, { inputs: { promote_run_id: '' } }), true);
    assert.equal(condition(job.if, { inputs: { promote_run_id: '123' } }), false);
  }
  assert.equal(publish.needs, undefined);
  const gate = (event_name, ref_type, promote_run_id) => condition(publish.if, { github: { event_name, ref_type }, inputs: { promote_run_id } });
  assert.equal(gate('push', 'tag', ''), false, 'a tag push never publishes');
  assert.equal(gate('workflow_dispatch', 'tag', ''), false, 'a plain dispatch never publishes');
  assert.equal(gate('workflow_dispatch', 'branch', '123'), false, 'a branch never publishes');
  assert.equal(gate('workflow_dispatch', 'tag', '123'), true);
  assert.deepEqual(publish.permissions, { actions: 'read', contents: 'read', 'id-token': 'write' });
  assert.equal(publish.concurrency.group, 'npm-publish-registry');
  assert.equal(publish.concurrency['cancel-in-progress'], false);
  assert.equal(checkout(publish).length, 0);
  const runs = publish.steps.map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(runs, /npm ci|cli:pack|npm run build/);
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(expr(download.with['run-id']), 'steps.origin.outputs.push_run');
  const origin = publish.steps.find((step) => step.id === 'origin');
  assert.ok(publish.steps.indexOf(origin) < publish.steps.indexOf(download));
  assert.match(origin.run, /\.github\/workflows\/release-promote\.yml/);
  assert.match(origin.run, /head_branch[\s\S]*"main"/);
  assert.match(origin.run, /"in_progress"/);
  assert.match(origin.run, /"Candidate preflight"/);
  assert.match(origin.run, /event=push&head_sha=\$\{SHA\}&per_page=100/);
  for (const job of REQUIRED_PUSH_JOBS) assert.ok(origin.run.includes(`'${job}'`), job);
  assert.match(origin.run, /select\(\.name == \$job\)/, 'each required job by its exact name, not a prefix');
  assert.doesNotMatch(origin.run, /"skipped"/, 'no verify job may be skipped');
  // Like promote.mjs assertPushRunJobs: a jobs page that does not hold every job of the run proves nothing.
  const listed = origin.run.indexOf('total_count');
  assert.ok(listed !== -1, 'the push run jobs answer is compared with total_count');
  assert.match(origin.run, /\.total_count[\s\S]*\.jobs \| length[\s\S]*!=|\.jobs \| length[\s\S]*\.total_count/);
  assert.ok(listed < origin.run.indexOf("for job in 'Pack and smoke nema'"), 'count checked before any job is judged');
  assert.match(runs, /check-tag\.mjs/);
  assert.match(runs, /merge-base --is-ancestor/);
  assert.match(runs, /refs\/heads\/main/);
  const publishStep = publish.steps.find((step) => (step.run ?? '').includes('npm publish'));
  const at = (text) => publishStep.run.indexOf(text);
  const publishAt = publishStep.run.lastIndexOf('npm publish');
  assert.ok(at('npm-state.mjs --integrity') !== -1 && at('npm-state.mjs --integrity') < publishAt, 'integrity before publish');
  assert.match(publishStep.run, /"\$got_integrity" != "\$EXPECTED_INTEGRITY"/);
  assert.ok(at('npm-state.mjs "$version"') < publishAt, 'registry state before publish');
  assert.ok(at('dist-tags.${dist}') !== -1 && at('dist-tags.${dist}') < publishAt, 'channel dist-tag re-read before publish');
  // Artifact files other than the tarball run with the OIDC token in reach: each must equal the tag commit's file first.
  const pinned = at('hash-object');
  assert.ok(pinned !== -1 && pinned < at('node artifact/'), 'artifact scripts are checked against the tag commit before any of them runs');
  assert.ok(at('merge-base --is-ancestor') < pinned, 'against the tag commit already resolved and checked');
  assert.match(publishStep.run, /dist-npm\/\*\) continue/);
  assert.match(publishStep.run, /dist=maintenance/);
  assert.ok(at('dist-tags.maintenance') > at('dist=maintenance') && at('dist-tags.maintenance') < publishAt, 'maintenance re-read before publish');
  assert.match(publishStep.run, /npm maintenance is \$\{held\}, newer than \$\{version\}; refusing to move it backwards/);
  assert.match(publishStep.run, /refusing to move it backwards/);
  assert.ok(publishStep.run.lastIndexOf('tag moved') < publishAt);
  assert.ok(publishStep.run.lastIndexOf('tag moved') > at('dist-tags.${dist}'), 'tag re-read after the dist-tag re-read');
  assert.match(publishStep.run, /npm publish --provenance --access public --tag "\$dist" "\.\/\$tarball"/);
  assert.match(publishStep.run.slice(publishAt), /npm-state\.mjs "\$version" "\$EXPECTED_INTEGRITY"\)\n\s*test "\$state" = same/, 'a failed publish counts only if the registry now holds the same tarball');
  assert.match(publishStep.run, /nema-project-nema-\*\.tgz/);
  assert.doesNotMatch(source, /-name 'nema-\*\.tgz'/);
  assertPinnedUses(workflow);
});

test('actual npm origin shell binds the promote run to the tag, treats the tag as data, and counts every push run job', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'npm-origin-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin')); mkdirSync(join(cwd, 'fix'));
  // gh api <url> [--jq <filter>] answers from fix/<url with every non-alphanumeric as _>.json, like gh does with --jq.
  writeFileSync(join(cwd, 'bin/gh'), `#!/bin/bash
set -euo pipefail
test "$1" = api
file="$FIX/$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_').json"
test -f "$file" || { echo "gh: unexpected $2" >&2; exit 1; }
if [ "\${3:-}" = --jq ]; then jq -r "$4" "$file"; else cat "$file"; fi
`, { mode: 0o755 });
  const sha = 'a'.repeat(40);
  const repo = 'o/r';
  const fixture = (url, body) => writeFileSync(join(cwd, 'fix', `${url.replace(/[^A-Za-z0-9]/g, '_')}.json`), JSON.stringify(body));
  const verifyJobs = REQUIRED_PUSH_JOBS.map((name) => ({ name, conclusion: 'success' }));
  const setup = ({ title = 'Release promote v1.2.3', runs = [{ id: 7, head_branch: 'v1.2.3', conclusion: 'success' }], runTotal, jobs = verifyJobs, total = jobs.length } = {}) => {
    fixture(`repos/${repo}/actions/runs/99`, { path: '.github/workflows/release-promote.yml', head_branch: 'main', status: 'in_progress', display_title: title });
    fixture(`repos/${repo}/actions/runs/99/jobs`, { total_count: 1, jobs: [{ name: 'Promote', steps: [{ name: 'Candidate preflight', conclusion: 'success' }] }] });
    fixture(`repos/${repo}/actions/workflows/npm-publish.yml/runs?event=push&head_sha=${sha}&per_page=100`, { total_count: runTotal ?? runs.length, workflow_runs: runs });
    for (const run of runs) fixture(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { total_count: total, jobs });
  };
  const script = read('npm-publish').jobs.publish.steps.find((step) => step.id === 'origin').run;
  const run = (tag = 'v1.2.3') => {
    const output = join(cwd, `out-${Math.random()}`); writeFileSync(output, '');
    const env = { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, FIX: join(cwd, 'fix'), GH_TOKEN: 'x', REPO: repo, TAG: tag, SHA: sha, PROMOTE_RUN_ID: '99', EXPECTED_INTEGRITY: `sha512-${'A'.repeat(86)}==`, GITHUB_OUTPUT: output };
    const result = spawnSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' });
    return { ...result, output: readFileSync(output, 'utf8') };
  };
  setup();
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'push_run=7\n');
  // A promote run for another tag cannot authorise this one.
  setup({ title: 'Release promote v1.2.4' });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /is not promoting v1\.2\.3/); assert.equal(result.output, '');
  // A valid tag name that is jq syntax must not select another tag's push run.
  const hostile = 'v1"or(true)or"';
  setup({ title: `Release promote ${hostile}`, runs: [{ id: 7, head_branch: 'v9.9.9', conclusion: 'success' }] });
  result = run(hostile);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no successful push run/); assert.equal(result.output, '');
  // A runs page that does not hold every run of the commit could hide the newest one.
  setup({ runTotal: 101 });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /runs answer does not hold every run/); assert.equal(result.output, '');
  // A jobs page that does not hold every job of the run proves nothing, even when every listed job passed.
  setup({ total: verifyJobs.length + 1 });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /lists 8 of 9 jobs/); assert.equal(result.output, '');
  // A missing matrix leg fails even when the count agrees with the shorter answer.
  setup({ jobs: verifyJobs.filter((job) => job.name !== 'verify / npm pack smoke (windows-latest)') });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /npm pack smoke \(windows-latest\) did not run and pass/); assert.equal(result.output, '');
  setup({ jobs: verifyJobs.map((job, i) => (i === 2 ? { ...job, conclusion: 'skipped' } : job)) });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Full application tests and web build did not run and pass/);
  setup({ jobs: verifyJobs.filter((job) => job.name !== 'Pack and smoke nema') });
  result = run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Pack and smoke nema did not run and pass/);
});

test('actual npm publish step: pins artifact scripts, publishes only an absent version, routes dist-tags, and never treats an error as done', t => {
  const root = mkdtempSync(join(tmpdir(), 'npm-publish-step-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // The tag commit: the scripts the publish step runs, as fakes whose answers come from the environment.
  const src = join(root, 'src');
  const files = {
    'scripts/npm/check-tag.mjs': "process.stdout.write(JSON.stringify({ distTag: process.env.FAKE_DIST ?? 'latest' }));\n",
    'scripts/release/npm-state.mjs': [
      "import { readFileSync, existsSync } from 'node:fs';",
      "if (process.argv[2] === '--integrity') { process.stdout.write(process.env.FAKE_INTEGRITY); process.exit(0); }",
      "const published = existsSync(process.env.NPM_LOG) && readFileSync(process.env.NPM_LOG, 'utf8').includes('publish');",
      "const state = published ? process.env.FAKE_STATE_AFTER : process.env.FAKE_STATE;",
      "process.stdout.write(state); process.exit(state === 'different' ? 3 : 0);",
      '',
    ].join('\n'),
  };
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(src, file, '..'), { recursive: true }); writeFileSync(join(src, file), text); }
  mkdirSync(join(src, 'scripts/desktop'), { recursive: true });
  copyFileSync(new URL('../desktop/release-version.mjs', import.meta.url), join(src, 'scripts/desktop/release-version.mjs'));
  sh(root, 'init', '-q', '-b', 'main', src);
  sh(src, 'add', '.'); sh(src, '-c', 'user.name=F', '-c', 'user.email=f@example.com', 'commit', '-qm', 'release');
  const sha = sh(src, 'rev-parse', 'HEAD');
  sh(src, 'tag', 'v1.2.3');
  sh(src, '-c', 'user.name=F', '-c', 'user.email=f@example.com', 'commit', '--allow-empty', '-qm', 'later');
  const later = sh(src, 'rev-parse', 'HEAD');
  sh(root, 'clone', '-q', '--bare', src, join(root, 'origin.git'));
  // https://github.com/o/r.git resolves to the local bare repository; nothing leaves the machine.
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, `[url "file://${join(root, 'origin.git')}"]\n\tinsteadOf = https://github.com/o/r.git\n`);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/npm'), `#!/bin/bash
set -euo pipefail
case "$1" in
  view) test "$2" = @nema-project/nema; name="TAG_\${3#dist-tags.}"; printf '%s\\n' "\${!name:-}" ;;
  publish) echo "$*" >> "$NPM_LOG"; exit "\${PUBLISH_EXIT:-0}" ;;
  *) echo "npm: unexpected $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const step = read('npm-publish').jobs.publish.steps.find((s) => (s.run ?? '').includes('npm publish'));
  const integrity = `sha512-${'A'.repeat(86)}==`;
  let n = 0;
  const run = ({ env = {}, tags = {}, edit } = {}) => {
    const cwd = join(root, `job-${n += 1}`);
    for (const file of Object.keys(files).concat('scripts/desktop/release-version.mjs')) {
      mkdirSync(join(cwd, 'artifact', file, '..'), { recursive: true });
      copyFileSync(join(src, file), join(cwd, 'artifact', file));
    }
    mkdirSync(join(cwd, 'artifact/dist-npm'));
    writeFileSync(join(cwd, 'artifact/dist-npm/nema-project-nema-1.2.3.tgz'), 'packed');
    edit?.(cwd);
    const log = join(cwd, 'npm.log');
    const result = spawnSync('bash', ['-c', step.run], { cwd, encoding: 'utf8', env: {
      ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GITHUB_TOKEN: '',
      TAG: 'v1.2.3', SHA: sha, REPO: 'o/r', EXPECTED_INTEGRITY: integrity, FAKE_INTEGRITY: integrity, FAKE_STATE: 'absent', FAKE_STATE_AFTER: 'same', NPM_LOG: log,
      ...Object.fromEntries(Object.entries(tags).map(([key, value]) => [`TAG_${key}`, value])), ...env,
    } });
    return { ...result, published: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };
  const publishedWith = (tag) => `publish --provenance --access public --tag ${tag} ./artifact/dist-npm/nema-project-nema-1.2.3.tgz\n`;
  // absent reaches npm publish on the channel tag.
  let r = run({ tags: { latest: '1.2.2' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.published, publishedWith('latest'));
  r = run({ env: { FAKE_DIST: 'next' }, tags: { latest: '1.2.2' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.published, publishedWith('next'), 'a first prerelease has no next yet');
  // same is done without publishing; different and an unanswered query fail before publishing.
  r = run({ env: { FAKE_STATE: 'same' } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already on npm with the expected tarball/); assert.equal(r.published, '');
  r = run({ env: { FAKE_STATE: 'different' } });
  assert.notEqual(r.status, 0); assert.equal(r.published, '');
  r = run({ env: { FAKE_STATE: 'unknown' } });
  assert.notEqual(r.status, 0); assert.equal(r.published, '');
  // The tarball must be the one promote verified.
  r = run({ env: { FAKE_INTEGRITY: `sha512-${'B'.repeat(86)}==` } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /release-promote expected/); assert.equal(r.published, '');
  // A tag that does not point at the dispatched commit stops before anything runs.
  r = run({ env: { SHA: later } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /tag moved/); assert.equal(r.published, '');
  // Artifact scripts must be the tag commit's files, on the real publish path.
  r = run({ edit: (cwd) => writeFileSync(join(cwd, 'artifact/scripts/release/npm-state.mjs'), "process.stdout.write('same');\n") });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /artifact file scripts\/release\/npm-state\.mjs differs from v1\.2\.3/); assert.equal(r.published, '');
  r = run({ edit: (cwd) => writeFileSync(join(cwd, 'artifact/scripts/release/extra.mjs'), 'export {};\n') });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /artifact file scripts\/release\/extra\.mjs is not in v1\.2\.3/); assert.equal(r.published, '');
  // Dist-tags: an older stable goes to maintenance, never backwards; an unrecognised value is an error.
  r = run({ tags: { latest: '2.0.0' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.published, publishedWith('maintenance'));
  r = run({ tags: { latest: '2.0.0', maintenance: '1.2.1' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.published, publishedWith('maintenance'));
  r = run({ tags: { latest: '2.0.0', maintenance: '1.9.0' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /npm maintenance is 1\.9\.0, newer than 1\.2\.3/); assert.equal(r.published, '');
  r = run({ env: { FAKE_DIST: 'next' }, tags: { next: '1.2.4' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /npm next is 1\.2\.4, newer than 1\.2\.3/); assert.equal(r.published, '');
  for (const tags of [{ latest: 'canary' }, { latest: '2.0.0', maintenance: 'oops' }]) {
    r = run({ tags });
    assert.notEqual(r.status, 0, JSON.stringify(tags)); assert.equal(r.published, '');
  }
  // A failed publish counts as done only when the registry then holds the same tarball.
  r = run({ env: { PUBLISH_EXIT: '1' }, tags: { latest: '1.2.2' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.published, publishedWith('latest'));
  r = run({ env: { PUBLISH_EXIT: '1', FAKE_STATE_AFTER: 'absent' }, tags: { latest: '1.2.2' } });
  assert.notEqual(r.status, 0); assert.equal(r.published, publishedWith('latest'));
});

test('release-promote runs main scripts only, treats the tag as data, and is the one pointer writer', () => {
  const promote = read('release-promote');
  const source = readFileSync(new URL('../../.github/workflows/release-promote.yml', import.meta.url), 'utf8');
  assert.deepEqual(Object.keys(promote.on), ['workflow_dispatch']);
  assert.equal(promote['run-name'], 'Release promote ${{ inputs.tag }}', 'npm-publish binds a promote run to its tag through this title');
  assert.equal(promote.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(promote.permissions.contents, 'read');
  assert.equal(promote.concurrency.group, 'release-promote');
  assert.equal(promote.concurrency['cancel-in-progress'], false);
  const job = promote.jobs.promote;
  assert.deepEqual(Object.keys(promote.jobs), ['authorize', 'promote']);
  // Write permissions exist only in a job that runs after a maintainer check that itself holds none.
  const { authorize } = promote.jobs;
  assert.deepEqual(authorize.permissions, { contents: 'read' });
  assert.equal(job.needs, 'authorize');
  assert.equal(condition(authorize.if, { github: { ref: 'refs/heads/main' } }), true);
  assert.equal(condition(authorize.if, { github: { ref: 'refs/heads/feature' } }), false);
  assert.equal(condition(job.if, { github: { ref: 'refs/heads/main' } }), true);
  assert.equal(condition(job.if, { github: { ref: 'refs/tags/v1.2.3' } }), false);
  assert.equal(condition(job.if, { github: { ref: 'refs/heads/feature' } }), false);
  assert.deepEqual(job.permissions, { actions: 'write', contents: 'write', packages: 'write' });
  assert.equal(source.includes('id-token'), false);
  assert.equal(source.includes('NPM_TOKEN'), false);
  assert.deepEqual([...new Set(source.match(/secrets\.[A-Za-z0-9_]+/g) ?? [])], ['secrets.GITHUB_TOKEN']);
  for (const step of checkout(job)) {
    assert.equal(expr(step.with.ref), 'github.sha');
    assert.equal(step.with['persist-credentials'], false);
  }
  assert.doesNotMatch(source, /ref:\s*\$\{\{\s*inputs\.tag/);
  const names = job.steps.map((step) => step.name).filter(Boolean);
  assert.deepEqual(names.filter((name) => ['Resolve tag', 'Candidate preflight', 'Promote'].includes(name)), ['Resolve tag', 'Candidate preflight', 'Promote']);
  const runs = job.steps.map((step) => step.run ?? '').join('\n');
  assert.match(job.steps.find((step) => step.name === 'Resolve tag').run, /readTagCommit[\s\S]*compare\/\$\{commit\}\.\.\.\$\{GITHUB_SHA\}/);
  assert.match(job.steps.find((step) => step.name === 'Candidate preflight').run, /promote\.mjs --preflight "\$TAG" "\$COMMIT"/);
  assert.match(job.steps.find((step) => step.name === 'Promote').run, /promote\.mjs "\$TAG" "\$COMMIT"/);
  // promote.mjs is the only writer: no inline crane tag, release edit, npm publish, tag or merge here.
  assert.doesNotMatch(runs, /crane"? tag|gh release edit|npm publish|git tag|gh pr merge|git push|npm ci/);
  assert.match(source, /CRANE_SHA256: 0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0/);
  const image = readFileSync(new URL('../../.github/workflows/image-publish.yml', import.meta.url), 'utf8');
  for (const key of ['CRANE_VERSION', 'CRANE_SHA256']) assert.equal(source.match(new RegExp(`${key}: (\\S+)`))[1], image.match(new RegExp(`${key}: (\\S+)`))[1], key);
  assertPinnedUses(promote);
});

test('actual release-promote authorize shell admits only maintain or admin for both the actor and the triggering actor', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'promote-authorize-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin'));
  // gh api repos/o/r/collaborators/<login>/permission [--jq f] answers the endpoint's JSON for the role in ROLES ("login=role ...").
  writeFileSync(join(cwd, 'bin/gh'), `#!/bin/bash
set -euo pipefail
test "$1" = api
login=$(printf '%s' "$2" | sed -n 's#^repos/o/r/collaborators/\\([^/]*\\)/permission$#\\1#p')
test -n "$login" || { echo "gh: unexpected $2" >&2; exit 1; }
for pair in $ROLES; do
  if [ "\${pair%%=*}" = "$login" ]; then
    # The endpoint answers JSON (legacy permission plus role_name); like gh, --jq filters it.
    body=$(jq -n --arg role "\${pair#*=}" '{permission: (if $role == "maintain" then "write" else $role end), role_name: $role, user: {login: "x"}}')
    if [ "\${3:-}" = --jq ]; then jq -r "$4" <<<"$body"; else printf '%s\\n' "$body"; fi
    exit 0
  fi
done
echo "gh: HTTP 404" >&2; exit 1
`, { mode: 0o755 });
  const workflow = read('release-promote');
  const script = workflow.jobs.authorize.steps.find((step) => step.name === 'Require a maintainer').run;
  // A re-run of the promote job alone reuses authorize: promote's first step is the same check.
  assert.equal(workflow.jobs.promote.steps[0].name, 'Require a maintainer');
  assert.equal(workflow.jobs.promote.steps[0].run, script);
  assert.equal(workflow.jobs.promote.steps[0].env.TRIGGERING_ACTOR, '${{ github.triggering_actor }}');
  const run = (actor, triggering, roles) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'x', GH_REPO: 'o/r', ACTOR: actor, TRIGGERING_ACTOR: triggering, ROLES: roles } });
  let result = run('owner', 'owner', 'owner=admin');
  assert.equal(result.status, 0, result.stderr);
  result = run('keeper', 'keeper', 'keeper=maintain');
  assert.equal(result.status, 0, result.stderr);
  result = run('writer', 'writer', 'writer=write');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /writer is write on o\/r; release-promote needs maintain or admin/);
  result = run('owner', 'writer', 'owner=admin writer=write');
  assert.notEqual(result.status, 0, 'a rerun by a writer of a maintainer run is refused'); assert.match(result.stderr, /writer is write/);
  result = run('stranger', 'stranger', 'owner=admin');
  assert.notEqual(result.status, 0, 'an unanswered permission query refuses');
});

test('promote requires every verify job and matrix leg the tag workflows define, by exact name', () => {
  const verify = read('verify');
  const names = Object.values(verify.jobs).flatMap((job) => {
    const os = job.strategy?.matrix?.os;
    return os ? os.map((value) => job.name.replace('${{ matrix.os }}', value)) : [job.name];
  }).map((name) => `verify / ${name}`);
  assert.deepEqual([...VERIFY_JOBS].sort(), names.sort());
  const image = read('image-publish');
  const imageJobs = Object.values(image.jobs).filter((job) => !job.uses).map((job) => job.name);
  assert.deepEqual(REQUIRED_TAG_RUN_JOBS['image-publish.yml'].filter((name) => !name.startsWith('verify / ')).sort(), imageJobs.sort());
  const desktop = read('desktop-release');
  assert.equal(desktop.jobs.build.name, 'Build and smoke (${{ matrix.target }})');
  const desktopFixed = Object.values(desktop.jobs).filter((job) => !job.uses && !job.strategy).map((job) => job.name);
  for (const name of desktopFixed) assert.ok(REQUIRED_TAG_RUN_JOBS['desktop-release.yml'].includes(name), name);
});

test('windows desktop release publishes a separate portable ZIP and still smokes NSIS', () => {
  const release = read('desktop-release');
  const runs = release.jobs.build.steps.map((step) => step.run ?? '').join('\n');
  assert.match(runs, /desktop:smoke -- --installer/);
  assert.match(runs, /desktop:smoke -- --zip "dist\/desktop-artifacts\/\$TARGET\/Nema-\$VERSION-\$TARGET\.zip"/);
  assert.match(runs, /release-manifest\.mjs verify/);
  const checksum = release.jobs.build.steps.find((step) => step.name === 'Checksums and upload set');
  assert.match(checksum.run, /if \[ "\$\{\{ matrix\.platform \}\}" = "win32" \]; then\n\s+cp "dist\/desktop-artifacts\/\$TARGET\/Nema-\$VERSION-\$TARGET\.zip"/);
});

test('release gates bind all stages to one SHA and fail closed on verification results', () => {
  const release = read('desktop-release'); assertRelease(release);
  const steps = release.jobs.publish.steps;
  const stamp = steps.findIndex(step => step.name === 'Stamp the Compose asset');
  const verify = steps.findIndex(step => step.name === 'Verify the complete asset set');
  assert.ok(stamp >= 0 && verify > stamp);
  assert.match(steps[verify].run, /compose-asset\/docker-compose\.yml/);
  const publish = steps.find(step => step.name === 'Create or reuse draft and upload');
  assert.match(publish.run, /gh release upload "\$TAG" release-assets\/\*/);
  assert.doesNotMatch(publish.run, /--draft=false/, 'release-promote publishes the draft');
  assert.match(publish.run, /--verify-remote[\s\S]*--verify-remote/);
  const wrongRef=structuredClone(release); checkout(wrongRef.jobs.build)[0].with.ref='main'; assert.throws(()=>assertRelease(wrongRef));
  const missingVerify=structuredClone(release); missingVerify.jobs.publish.needs=['plan','build']; assert.throws(()=>assertRelease(missingVerify));
});

test('desktop pull request paths stay equal to the policy desktop class', () => {
  const pull = read('desktop-release').on.pull_request;
  // GitHub rejects paths and paths-ignore on one event. Later ! patterns skip
  // Markdown in scripts/desktop and in a subfolder; policy does the same.
  assert.equal(pull['paths-ignore'], undefined);
  assert.deepEqual(pull.paths, ['apps/desktop/**', 'scripts/desktop/**', '!scripts/desktop/**/*.md', '!scripts/desktop/*.md']);
  assert.equal(classifyPaths(['apps/desktop/package.json']).desktop, true);
  assert.equal(classifyPaths(['apps/desktop/main.cjs']).desktop, true);
  assert.equal(classifyPaths(['scripts/desktop/smoke-desktop.test.mjs']).desktop, true);
  assert.equal(classifyPaths(['scripts/desktop/RELEASE.md']).desktop, false);
  assert.equal(classifyPaths(['package-lock.json']).desktop, false);
  assert.equal(classifyPaths(['apps/web/app/page.tsx']).desktop, false);
});

test('image smoke paths are fixed and the workflow is not invented', () => {
  const imagePaths = ['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/**', '.github/workflows/image-publish.yml', '!scripts/images/**/*.md', '!scripts/images/*.md'];
  for (const path of ['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/smoke-compose.mjs', '.github/workflows/image-publish.yml']) {
    const classified = classifyPaths([path]);
    assert.equal(classified.image, true, path);
    assert.equal(classified.mode, 'app', path);
    assert.equal(classified.platform, false, path);
    assert.equal(classified.npmPack, false, path);
  }
  assert.equal(classifyPaths(['apps/web/app/page.tsx']).image, false);
  const image = read('image-publish');
  assert.equal(existsSync(new URL('../../.github/workflows/image-publish.yml', import.meta.url)), true);
  assert.equal(image.on.pull_request['paths-ignore'], undefined);
  assert.deepEqual(image.on.pull_request.paths, imagePaths);
  assert.equal(classifyPaths(['scripts/images/smoke-compose.mjs']).image, true);
  assert.equal(classifyPaths(['scripts/images/RELEASE.md']).image, false);
  assert.match(expr(image.jobs.publish.if), /github\.event_name == 'push'/);
  const plan = image.jobs.plan.steps.find((step) => step.id === 'commit').run;
  assert.match(plan, /"\$EVENT" = "push"/);
  assert.match(plan, /"\$REF_TYPE" = "tag"/);
  assert.match(plan, /"\$VERIFY_FULL" = "true"/);
  assert.doesNotMatch(plan, /pull_request/);
  assert.equal(expr(image.jobs.verify.if), "needs.plan.outputs.verification_required == 'true'");
  for (const key of ['app_tests', 'platform', 'npm_pack']) assert.notEqual(image.jobs.verify.with[key], false, key);
});

test('actual draft shell refuses a tag moved during upload and never makes the draft public', t => {
  const cwd=mkdtempSync(join(tmpdir(),'publish-gate-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.com');git('config','user.name','Fixture');
  git('commit','--allow-empty','-qm','verified');const commit=git('rev-parse','HEAD');
  git('tag','-a','v1.2.3','-m','annotated');git('commit','--allow-empty','-qm','unchecked');const other=git('rev-parse','HEAD');
  git('clone','--bare','.',join(cwd,'remote.git'));git('remote','add','origin',join(cwd,'remote.git'));git('checkout','-q',commit);
  mkdirSync(join(cwd,'scripts/desktop'),{recursive:true});copyFileSync(new URL('../desktop/release-commit.mjs',import.meta.url),join(cwd,'scripts/desktop/release-commit.mjs'));
  mkdirSync(join(cwd,'release-assets'));writeFileSync(join(cwd,'release-assets/artifact.txt'),'fixture');
  mkdirSync(join(cwd,'bin'));
  writeFileSync(join(cwd,'bin/gh'),`#!/bin/bash
set -euo pipefail
case "$2" in
  upload) touch "$UPLOAD_MARKER"; if [ "$MOVE_TAG" = true ]; then git --git-dir="$REMOTE" update-ref refs/tags/v1.2.3 "$OTHER"; fi ;;
  view) echo artifact.txt ;;
  edit) for arg in "$@"; do if [ "$arg" = --draft=false ]; then touch "$PUBLISH_MARKER"; fi; done ;;
esac
`,{mode:0o755});
  const env={...process.env,PATH:`${join(cwd,'bin')}:${process.env.PATH}`,TAG:'v1.2.3',RELEASE_COMMIT:commit,VERSION:'1.2.3',PRERELEASE:'false',DRAFT_EXISTS:'true',MOVE_TAG:'true',REMOTE:join(cwd,'remote.git'),OTHER:other,PUBLISH_MARKER:join(cwd,'published'),UPLOAD_MARKER:join(cwd,'uploaded')};
  const script=read('desktop-release').jobs.publish.steps.find(s=>s.name==='Create or reuse draft and upload').run;
  const run=()=>spawnSync('bash',['-c',script],{cwd,env,encoding:'utf8'});
  let result=run();assert.notEqual(result.status,0,result.stderr);assert.match(result.stderr,/tag moved/i);assert.equal(existsSync(env.PUBLISH_MARKER),false);assert.doesNotMatch(result.stdout,/holds the verified asset set/);
  // The same workflow shell also refuses movement before draft operations.
  result=run();assert.notEqual(result.status,0);assert.equal(existsSync(env.PUBLISH_MARKER),false);
  git('--git-dir='+env.REMOTE,'update-ref','refs/tags/v1.2.3',commit);env.MOVE_TAG='false';
  result=run();assert.equal(result.status,0,result.stderr);assert.equal(existsSync(env.UPLOAD_MARKER),true);assert.equal(existsSync(env.PUBLISH_MARKER),false,'the draft stays a draft');assert.match(result.stdout,/Draft v1\.2\.3 holds the verified asset set/);
});

function assertPinnedUses(doc) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.uses === 'string' && !node.uses.startsWith('./')) {
      assert.match(node.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
}

test('image publish pushes pinned GHCR images only after verify, and only from the publish job', () => {
  const image = read('image-publish');
  assert.deepEqual(Object.keys(image.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(image.on.push.tags, ['v*']);
  assert.equal(image.on.pull_request['paths-ignore'], undefined);
  assert.deepEqual(image.on.pull_request.paths, ['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/**', '.github/workflows/image-publish.yml', '!scripts/images/**/*.md', '!scripts/images/*.md']);
  assert.equal(image.permissions.contents, 'read');
  assert.equal(image.permissions.packages, undefined);
  assertRelease(image);
  const planSteps = image.jobs.plan.steps;
  const helperIndex = planSteps.findIndex((step) => step.name === 'Image helper tests');
  const installIndex = planSteps.findIndex((step) => step.run === 'npm ci --ignore-scripts');
  assert.ok(installIndex >= 0 && installIndex < helperIndex, 'install dependencies before image helper tests');
  assert.equal(image.jobs.build.permissions?.packages, undefined);
  assert.deepEqual(image.jobs.publish.permissions, {contents: 'read', packages: 'write'});
  assert.deepEqual([...image.jobs.smoke.needs].sort(), ['plan', 'publish']);
  assert.deepEqual(image.jobs.smoke.permissions, {contents: 'read', packages: 'read'});
  assert.equal(expr(image.jobs.smoke.if), "needs.publish.result == 'success'");
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    assert.equal(condition(image.jobs.smoke.if, {needs: {publish: {result}}}), result === 'success');
  }
  const buildText = image.jobs.build.steps.map((step) => `${step.name ?? ''}\n${step.run ?? ''}`).join('\n');
  assert.match(buildText, /linux\/amd64/);
  assert.match(buildText, /provenance=mode=max/);
  assert.match(buildText, /sbom=true/);
  assert.match(buildText, /--pull never/);
  const publishText = image.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(publishText, /docker build/);
  assert.doesNotMatch(publishText, /npm ci/);
  assert.match(publishText, /release-commit\.mjs --verify-remote/);
  assert.match(publishText, /push --index/);
  assert.equal(image.jobs.publish.concurrency.group, 'image-publish-registry');
  assert.equal(image.jobs.publish.concurrency['cancel-in-progress'], false);
  const pushStep = image.jobs.publish.steps.find((step) => (step.run ?? '').includes('push --index'));
  assert.match(pushStep.run, /verify-remote[\s\S]*push --index/);
  assert.match(pushStep.run, /push_one hub\n\s*push_one web/);
  assert.doesNotMatch(pushStep.run, /\blatest\b/);
  // release-promote moves latest after the whole release verifies; this workflow pushes the version tag only.
  assert.doesNotMatch(publishText, /--move-latest/);
  assert.doesNotMatch(publishText, /crane"? tag /);
  assert.equal(image.jobs.publish.steps.some((step) => /latest/i.test(step.name ?? '')), false);
  const smokeText = image.jobs.smoke.steps.map((step) => step.run ?? '').join('\n');
  assert.match(smokeText, /docker compose pull/);
  assert.match(smokeText, /scripts\/images\/smoke-compose\.mjs --pull always --hub-port 4410 --web-port 3010/);
  assert.match(buildText, /smoke-compose\.mjs --pull never --hub-port 4410 --web-port 3010/);
  assert.match(smokeText, /--pull always/);
  assert.doesNotMatch(smokeText, /docker build/);
  const composeSteps = Object.values(image.jobs).flatMap((job) => job.steps ?? []).filter((step) => /docker compose|smoke-compose\.mjs/.test(step.run ?? ''));
  assert.equal(composeSteps.length, 3);
  for (const step of composeSteps) {
    assert.equal(expr(step.env?.NEMA_IMAGE_TAG), 'needs.plan.outputs.version');
    assert.match(step.run, /test -n "\$NEMA_IMAGE_TAG"/);
  }
  for (const [job, command] of [[image.jobs.build, '--pull never'], [image.jobs.smoke, 'docker compose pull'], [image.jobs.smoke, '--pull always']]) {
    const step = job.steps.find((item) => (item.run ?? '').includes(command));
    assert.ok(step);
    assert.equal(expr(step.env?.NEMA_IMAGE_TAG), 'needs.plan.outputs.version');
  }
  const raw = readFileSync(new URL('../../.github/workflows/image-publish.yml', import.meta.url), 'utf8');
  assert.equal(raw.includes('id-token'), false);
  assert.deepEqual([...new Set(raw.match(/secrets\.[A-Za-z0-9_]+/g) ?? [])], ['secrets.GITHUB_TOKEN']);
  assertPinnedUses(image);
  const verifyRaw = readFileSync(new URL('../../.github/workflows/verify.yml', import.meta.url), 'utf8');
  assert.match(verifyRaw, /scripts\/images\/\*\.test\.mjs/);
});
