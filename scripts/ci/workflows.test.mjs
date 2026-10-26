import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
const read = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const checkout = job => job.steps.filter(s => s.uses?.startsWith('actions/checkout@'));
const expr = value => value?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();

function assertCi(ci) {
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.ok(Object.hasOwn(ci.on, 'workflow_dispatch'));
  assert.equal(ci.on.pull_request?.['paths-ignore'], undefined);
  assert.equal(ci.on.pull_request?.paths, undefined);
  assert.equal(ci.on.pull_request_target, undefined);
  assert.equal(ci.permissions.contents, 'read');
  assert.equal(ci.jobs.gate.name, 'CI gate');
  assert.equal(expr(ci.jobs.gate.if), 'always()');
  assert.deepEqual([...ci.jobs.gate.needs].sort(), ['classify','docs','verify']);
  assert.equal(ci.jobs.verify.uses, './.github/workflows/verify.yml');
  assert.equal(expr(ci.jobs.verify.with.checkout_ref), 'github.sha');
  assert.equal(ci.jobs.verify.secrets, undefined);
  assert.equal(expr(ci.jobs.verify.if), "needs.classify.outputs.mode == 'full'");
  const step = ci.jobs.gate.steps.find(s => s.run === 'node scripts/ci/policy.mjs');
  assert.ok(step);
  for (const [key,value] of Object.entries({MODE:'needs.classify.outputs.mode', CLASSIFY:'needs.classify.result', DOCS:'needs.docs.result', VERIFY:'needs.verify.result'})) assert.equal(expr(step.env[key]), value);
  return step;
}

test('PR gate runs for every PR and forwards actual dependency results to the policy', () => {
  const ci = read('ci'); const step = assertCi(ci);
  for (const verify of ['success','failure','cancelled','skipped','']) {
    const run = spawnSync(process.execPath, ['scripts/ci/policy.mjs'], {env:{...process.env, MODE:'full', CLASSIFY:'success', DOCS:'success', VERIFY:verify}});
    assert.equal(run.status, verify === 'success' ? 0 : 1);
  }
  const mutation = structuredClone(ci);
  mutation.jobs.gate.steps.find(s => s.run === step.run).env.VERIFY = 'success';
  assert.throws(() => assertCi(mutation));
  const skipped = structuredClone(ci); skipped.jobs.gate.if = 'success()';
  assert.throws(() => assertCi(skipped));
});

test('reusable verification checks the supplied ref with the complete existing suite', () => {
  const verify = read('verify');
  assert.deepEqual(verify.on.workflow_call.inputs.checkout_ref, {required:true, type:'string'});
  assert.equal(verify.permissions.contents, 'read');
  for (const job of Object.values(verify.jobs)) {
    assert.equal(job.if, undefined);
    assert.equal(job['continue-on-error'], undefined);
    for (const step of checkout(job)) {
      assert.equal(expr(step.with.ref), 'inputs.checkout_ref');
      assert.equal(step.with['persist-credentials'], false);
    }
  }
  assert.deepEqual(verify.jobs.platform.strategy.matrix.os, ['macos-latest','windows-latest']);
  const runs = verify.jobs.test.steps.map(s => s.run);
  for (const command of ['npm ci','npm run typecheck','npm test -- --maxWorkers=2','npm run build -w apps/hub','npm run build -w apps/cli','npm run lint -w apps/web','npm run build -w apps/web','npm run setup:check','npm run up','docker compose down']) assert.ok(runs.includes(command), command);
  assert.ok(runs.indexOf('npm run typecheck') < runs.indexOf('npm test -- --maxWorkers=2'));
  assert.equal(verify.jobs.test.steps.find(s => s.run === 'docker compose down').if, 'always()');
});
