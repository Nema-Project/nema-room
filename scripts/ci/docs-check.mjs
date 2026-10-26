import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

export async function checkDocs({root, paths}) {
  root = await realpath(root);
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) throw new TypeError('Expected Git path array');
  const errors = [];
  for (const path of paths) {
    const file = resolve(root, path);
    if (!inside(root, file)) throw new Error(`Path outside repository: ${path}`);
    if (!/\.(md|html)$/i.test(path)) continue;
    try { if (!(await stat(file)).isFile()) continue; }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!inside(root, await realpath(file))) { errors.push(`${path}: file escapes repository`); continue; }
    let source = await readFile(file, 'utf8');
    source = source.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/(`+)[\s\S]*?\1/g, '').replace(/<!--[\s\S]*?-->/g, '');
    if (/\[[^\]\n]+\]\s*\[[^\]\n]*\]|^\s*\[[^\]]+\]:/m.test(source)) errors.push(`${path}: unsupported reference-link syntax; use inline links for validation`);
    const links = [...source.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(m => m[1].replace(/^<|>$/g, ''));
    links.push(...[...source.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
    for (const link of links) {
      if (!link || link.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      let target;
      try { target = decodeURIComponent(link.split(/[?#]/)[0]); }
      catch { errors.push(`${path}: invalid URL ${link}`); continue; }
      if (!target) continue;
      const destination = target.startsWith('/') ? resolve(root, `.${target}`) : resolve(dirname(file), target);
      if (!inside(root, destination)) { errors.push(`${path}: link escapes repository: ${link}`); continue; }
      try {
        if (!inside(root, await realpath(destination))) errors.push(`${path}: link escapes repository: ${link}`);
      } catch (error) { if (error.code === 'ENOENT') errors.push(`${path}: missing link target ${link}`); else throw error; }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const errors = await checkDocs({root:process.cwd(), paths});
  for (const error of errors) console.error(error);
  console.log(`Documentation check: ${errors.length} errors; inline Markdown and HTML local links only (anchors and remote URLs not checked).`);
  process.exitCode = errors.length ? 1 : 0;
}
