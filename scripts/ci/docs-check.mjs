import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

export async function checkDocs({root, paths, siteBasePath = "/nema-room/"}) {
  root = await realpath(root);
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) throw new TypeError('Expected Git path array');
  const errors = [];
  // Always inspect active reporting routes, even for a docs-only PR with no Markdown changes.
  const optional = async path => {
    try {
      const file = resolve(root, path);
      if (!inside(root, await realpath(file))) throw new Error(`Path outside repository: ${path}`);
      return await readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  for (const path of ['.github/ISSUE_TEMPLATE/security.yml', '.github/ISSUE_TEMPLATE/security.yaml']) {
    if (await optional(path) !== null) errors.push(`${path}: public security issue form must be removed`);
  }
  const active = ['SECURITY.md', 'CONTRIBUTING.md', 'README.md', 'README.en.md', 'README.zh.md', 'README.ja.md',
    'docs/guide.en.md', 'docs/guide.zh.md', 'docs/guide.ja.md', '.github/ISSUE_TEMPLATE/config.yml'];
  for (const path of active) {
    const content = await optional(path);
    if (content === null) continue;
    if (/issues\/new[^\s)]*template=security\.ya?ml/i.test(content)) errors.push(`${path}: public security issue link must be removed`);
    if (path === 'SECURITY.md' && /repository is private|本仓库是私有|リポジトリは非公開|no desktop release is published|还没有发布版本/i.test(content)) errors.push(`${path}: obsolete security guidance`);
  }
  const primary = await optional('README.md'), english = await optional('README.en.md');
  if (primary !== english) errors.push('English README files must be byte-identical');
  for (const path of paths) {
    const file = resolve(root, path);
    if (!inside(root, file)) throw new Error(`Path outside repository: ${path}`);
    if (!/\.(md|mdx|html)$/i.test(path)) continue;
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
      const siteHtml = path.startsWith('site/') && /\.html$/i.test(path);
      const boundary = siteHtml ? resolve(root, 'site') : root;
      if (siteHtml && target.startsWith('/') && !target.startsWith(siteBasePath) && target !== siteBasePath.slice(0, -1)) {
        errors.push(`${path}: link outside deployed Pages prefix ${siteBasePath}: ${link}`); continue;
      }
      let destination = target.startsWith('/')
        ? resolve(boundary, siteHtml ? target.slice(siteBasePath.length) : `.${target}`)
        : resolve(dirname(file), target);
      if (!inside(boundary, destination)) { errors.push(`${path}: link escapes ${siteHtml ? 'deployed site' : 'repository'}: ${link}`); continue; }
      try {
        if (siteHtml && (await stat(destination)).isDirectory()) destination = resolve(destination, 'index.html');
        if (!inside(boundary, await realpath(destination))) errors.push(`${path}: link escapes ${siteHtml ? 'deployed site' : 'repository'}: ${link}`);
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
