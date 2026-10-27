import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result;
}

test('graphify extract finishes when the verilog grammar is absent', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-lang-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // pip --target avoids python3-venv, which GitHub's Ubuntu image does not always have.
  const site = path.join(root, 'py');
  await mkdir(site);
  const pip = (args) => run('python3', ['-m', 'pip', 'install', '--disable-pip-version-check', '--target', site, ...args]);
  pip(['--no-deps', 'graphifyy==0.9.95']);
  pip(['tree-sitter==0.25.2', 'tree-sitter-javascript==0.25.0', 'networkx==3.6.1', 'numpy==2.4.6', 'rapidfuzz==3.14.6', 'pyyaml==6.0.3']);
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus);
  await writeFile(path.join(corpus, 'hello.js'), 'function smokeGreet() { return 1; }\n');
  await writeFile(path.join(corpus, 'chip.v'), 'module chip; endmodule\n');
  const result = spawnSync('python3', ['-m', 'graphify', 'extract', corpus, '--code-only'], {
    cwd: corpus,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GRAPHIFY_BACKEND: 'none', PYTHONNOUSERSITE: '1', PYTHONPATH: site },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, output);
  assert.equal(output.includes('Traceback'), false, output);
  assert.match(output, /verilog/i);
  assert.match(output, /not installed/);
  const graph = await readFile(path.join(corpus, 'graphify-out', 'graph.json'), 'utf8');
  assert.match(graph, /smokeGreet/);
});
