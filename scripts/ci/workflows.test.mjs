import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { classifyPaths } from './policy.mjs';
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
  source = source.replace(/needs\.[\w.]+|github\.event_name/g, key => JSON.stringify(key.split('.').reduce((v,k) => v?.[k], context) ?? ''));
  assert.match(source, /^[\s\w'"!&|=().-]+$/);
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

test('npm publish uses OIDC on a verified tag and skips a dry run', () => {
  const workflow = read('npm-publish');
  const source = readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.equal(source.includes('NPM_TOKEN'), false);
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.workflow_call, undefined);
  const { verify, build, publish } = workflow.jobs;
  assert.equal(verify.uses, './.github/workflows/verify.yml');
  assert.equal(expr(verify.with.checkout_ref), 'github.sha');
  assert.equal(build.permissions['id-token'], undefined);
  assert.equal(build.permissions.contents, 'read');
  assert.equal(expr(checkout(build)[0].with.ref), 'github.sha');
  assert.ok(build.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));
  assert.deepEqual([...publish.needs].sort(), ['build', 'verify']);
  assert.equal(publish.permissions['id-token'], 'write');
  assert.equal(publish.permissions.contents, 'read');
  assert.deepEqual(Object.keys(publish.permissions).sort(), ['contents', 'id-token']);
  assert.equal(checkout(publish).length, 0);
  assert.ok(publish.steps.some((step) => step.uses?.startsWith('actions/download-artifact@')));
  const runs = publish.steps.map((step) => step.run ?? '').join('\n');
  assert.match(runs, /check-tag\.mjs/);
  assert.match(runs, /merge-base --is-ancestor/);
  assert.match(runs, /refs\/heads\/main/);
  const publishStep = publish.steps.find((step) => (step.run ?? '').includes('npm publish'));
  const publishAt = publishStep.run.lastIndexOf('npm publish');
  const recheckAt = publishStep.run.lastIndexOf('tag moved');
  assert.ok(recheckAt !== -1 && recheckAt < publishAt);
  assert.match(publishStep.run, /--tag "\$dist"/);
  assert.match(runs, /npm publish --provenance --access public/);
  assert.match(publishStep.run, /nema-project-nema-\*\.tgz/);
  assert.match(publishStep.run, /"\.\/\$tarball"/);
  assert.doesNotMatch(source, /-name 'nema-\*\.tgz'/);
  assert.doesNotMatch(runs, /npm ci|cli:pack|npm run build/);
  const context = (event, verifyResult) => ({ github: { event_name: event }, needs: { verify: { result: verifyResult }, build: { result: 'success' } } });
  assert.equal(condition(publish.if, context('workflow_dispatch', 'success')), false);
  assert.equal(condition(publish.if, context('push', 'success')), true);
  assert.equal(condition(publish.if, context('push', 'failure')), false);
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
  const wrongRef=structuredClone(release); checkout(wrongRef.jobs.build)[0].with.ref='main'; assert.throws(()=>assertRelease(wrongRef));
  const missingVerify=structuredClone(release); missingVerify.jobs.publish.needs=['plan','build']; assert.throws(()=>assertRelease(missingVerify));
});

test('desktop pull request paths stay equal to the policy desktop class', () => {
  assert.deepEqual(read('desktop-release').on.pull_request.paths, ['apps/desktop/**', 'scripts/desktop/**']);
  assert.equal(classifyPaths(['apps/desktop/package.json']).desktop, true);
  assert.equal(classifyPaths(['scripts/desktop/smoke-desktop.test.mjs']).desktop, true);
  assert.equal(classifyPaths(['package-lock.json']).desktop, false);
  assert.equal(classifyPaths(['apps/web/app/page.tsx']).desktop, false);
});

test('image smoke paths are fixed and the workflow is not invented', () => {
  const imagePaths = ['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/**', '.github/workflows/image-publish.yml'];
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
  assert.deepEqual(image.on.pull_request.paths, imagePaths);
  assert.match(expr(image.jobs.publish.if), /github\.event_name == 'push'/);
  const plan = image.jobs.plan.steps.find((step) => step.id === 'commit').run;
  assert.match(plan, /"\$EVENT" = "push"/);
  assert.match(plan, /"\$REF_TYPE" = "tag"/);
  assert.match(plan, /"\$VERIFY_FULL" = "true"/);
  assert.doesNotMatch(plan, /pull_request/);
  assert.equal(expr(image.jobs.verify.if), "needs.plan.outputs.verification_required == 'true'");
  for (const key of ['app_tests', 'platform', 'npm_pack']) assert.notEqual(image.jobs.verify.with[key], false, key);
});

test('actual publication shell refuses a tag moved during upload before making the draft public', t => {
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
  upload) if [ "$MOVE_TAG" = true ]; then git --git-dir="$REMOTE" update-ref refs/tags/v1.2.3 "$OTHER"; fi ;;
  view) echo artifact.txt ;;
  edit) for arg in "$@"; do if [ "$arg" = --draft=false ]; then touch "$PUBLISH_MARKER"; fi; done ;;
esac
`,{mode:0o755});
  const env={...process.env,PATH:`${join(cwd,'bin')}:${process.env.PATH}`,TAG:'v1.2.3',RELEASE_COMMIT:commit,VERSION:'1.2.3',PRERELEASE:'false',DRAFT_EXISTS:'true',MOVE_TAG:'true',REMOTE:join(cwd,'remote.git'),OTHER:other,PUBLISH_MARKER:join(cwd,'published')};
  const script=read('desktop-release').jobs.publish.steps.find(s=>s.name==='Create or reuse draft, upload, publish').run;
  const run=()=>spawnSync('bash',['-c',script],{cwd,env,encoding:'utf8'});
  let result=run();assert.notEqual(result.status,0,result.stderr);assert.match(result.stderr,/tag moved/i);assert.equal(existsSync(env.PUBLISH_MARKER),false);
  // The same workflow shell also refuses movement before draft operations.
  result=run();assert.notEqual(result.status,0);assert.equal(existsSync(env.PUBLISH_MARKER),false);
  git('--git-dir='+env.REMOTE,'update-ref','refs/tags/v1.2.3',commit);env.MOVE_TAG='false';
  result=run();assert.equal(result.status,0,result.stderr);assert.equal(existsSync(env.PUBLISH_MARKER),true);
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
  assert.deepEqual(image.on.pull_request.paths, ['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/**', '.github/workflows/image-publish.yml']);
  assert.equal(image.permissions.contents, 'read');
  assert.equal(image.permissions.packages, undefined);
  assertRelease(image);
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
  const latest = image.jobs.publish.steps.find((step) => (step.run ?? '').includes('--move-latest'));
  assert.equal(expr(latest.if), "needs.plan.outputs.prerelease == 'false'");
  assert.match(latest.run, /--verify-remote/);
  assert.match(latest.run, /digest[\s\S]*--move-latest[\s\S]*--verify-remote[\s\S]*tag /);
  assert.match(latest.run, /MANIFEST_UNKNOWN[\s\S]*refusing to move latest/);
  assert.doesNotMatch(latest.run, /push --index/);
  const smokeText = image.jobs.smoke.steps.map((step) => step.run ?? '').join('\n');
  assert.match(smokeText, /docker compose pull/);
  assert.match(smokeText, /scripts\/images\/smoke-compose\.mjs --pull always --hub-port 4410 --web-port 3010/);
  assert.match(buildText, /smoke-compose\.mjs --pull never --hub-port 4410 --web-port 3010/);
  assert.match(smokeText, /--pull always/);
  assert.doesNotMatch(smokeText, /docker build/);
  const raw = readFileSync(new URL('../../.github/workflows/image-publish.yml', import.meta.url), 'utf8');
  assert.equal(raw.includes('id-token'), false);
  assert.deepEqual([...new Set(raw.match(/secrets\.[A-Za-z0-9_]+/g) ?? [])], ['secrets.GITHUB_TOKEN']);
  assertPinnedUses(image);
  const verifyRaw = readFileSync(new URL('../../.github/workflows/verify.yml', import.meta.url), 'utf8');
  assert.match(verifyRaw, /scripts\/images\/\*\.test\.mjs/);
});
