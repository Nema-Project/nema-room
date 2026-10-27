import { pathToFileURL } from 'node:url';

export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new TypeError('Expected an array of nonempty Git paths');
  }
  const documentation = p => {
    if (p.startsWith('/') || p.includes('\\') || p.split('/').some(s => s === '..' || s === '.') || /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(p)) return false;
    if (p === '.github/workflows/pages.yml') return true;
    if (!p.includes('/') && /\.md$/i.test(p)) return true;
    // Executable files under docs are not documentation. Site assets retain the Pages allowlist.
    return /^(docs|site)\//.test(p) && /\.(md|mdx|txt|html|css|png|jpg|jpeg|svg|gif|webp|ico|pdf|woff2?|ttf)$/i.test(p);
  };
  return paths.length && paths.every(documentation) ? 'docs' : 'full';
}

export function gatePasses({mode, classify, docs, verify}) {
  if (classify !== 'success' || docs !== 'success') return false;
  return mode === 'full' ? verify === 'success' : mode === 'docs' && (verify === 'success' || verify === 'skipped');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const passed = gatePasses({mode:process.env.MODE, classify:process.env.CLASSIFY, docs:process.env.DOCS, verify:process.env.VERIFY});
  console.log(passed ? 'CI gate passed' : 'CI gate blocked: required verification did not succeed');
  process.exitCode = passed ? 0 : 1;
}
