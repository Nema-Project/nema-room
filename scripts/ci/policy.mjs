import { pathToFileURL } from 'node:url';

const under = (path, prefix) => path.startsWith(`${prefix}/`);
const platformPrefixes = ['apps/cli', 'apps/local', 'apps/desktop', 'packages/knowledge', 'scripts/desktop', 'scripts/security'];
const npmPrefixes = ['apps/cli', 'packages/shared', 'scripts/npm'];
const platformFiles = new Set(['scripts/setup.mjs', 'scripts/setup.test.mjs', 'scripts/release-notes.test.mjs', 'package.json', 'package-lock.json']);
const npmFiles = new Set(['scripts/setup.mjs', 'scripts/setup.test.mjs', 'package.json', 'package-lock.json', '.github/workflows/npm-publish.yml', 'LICENSE', 'LICENCE', 'COPYING']);
const imageFiles = new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', '.github/workflows/image-publish.yml']);
const gateFiles = new Set(['.github/workflows/ci.yml', '.github/workflows/verify.yml']);

function unsafe(path) {
  return path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}

// Markdown with a consumer is not prose. These four are shipped or read, so a change to one has to
// run its consumer's checks instead of the docs fast lane:
//   apps/cli/src/report/SKILL.md              bundled into the npm package, installed as a skill
//   vendor/superpowers-rules/{spec,plan}-rules.md   read by the hub at startup, staged into the desktop
//   vendor/archify/THIRD_PARTY_NOTICES.md     required by the desktop runtime staging step
// Other vendor notes travel inside a staged tree but nothing reads them.
const consumedMarkdown = new Set([
  'apps/cli/src/report/SKILL.md',
  'vendor/superpowers-rules/spec-rules.md',
  'vendor/superpowers-rules/plan-rules.md',
  'vendor/archify/THIRD_PARTY_NOTICES.md',
]);

function documentation(path) {
  if (path === '.github/workflows/pages.yml') return true;
  if (!path.includes('/') && /^(LICEN[CS]E|COPYING)$/i.test(path)) return false;
  if (/\.mdx?$/i.test(path)) return !consumedMarkdown.has(path);
  // Executable files under docs are not documentation. Site assets retain the Pages allowlist.
  return /^(docs|site)\//.test(path) && /\.(md|mdx|txt|html|css|png|jpg|jpeg|svg|gif|webp|ico|pdf|woff2?|ttf)$/i.test(path);
}

function classes(path) {
  const gate = gateFiles.has(path) || under(path, 'scripts/ci');
  const prose = documentation(path);
  const heavyScript = !prose;
  return {
    platform: heavyScript && (gate || platformFiles.has(path) || platformPrefixes.some(prefix => under(path, prefix))),
    npmPack: heavyScript && (gate || npmFiles.has(path) || npmPrefixes.some(prefix => under(path, prefix))),
    desktop: heavyScript && (under(path, 'apps/desktop') || under(path, 'scripts/desktop')),
    image: heavyScript && (imageFiles.has(path) || under(path, 'scripts/images')),
  };
}

export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new TypeError('Expected an array of nonempty Git paths');
  }
  // Empty segments match the docs predicate (`docs//guide.md`), so reject the shape first.
  if (!paths.length || paths.some(unsafe)) return {mode: 'full', platform: true, npmPack: true, desktop: false, image: false};
  if (paths.every(documentation)) return {mode: 'docs', platform: false, npmPack: false, desktop: false, image: false};
  const flags = paths.reduce((acc, path) => {
    const flag = classes(path);
    return {
      platform: acc.platform || flag.platform,
      npmPack: acc.npmPack || flag.npmPack,
      desktop: acc.desktop || flag.desktop,
      image: acc.image || flag.image,
    };
  }, {platform: false, npmPack: false, desktop: false, image: false});
  return {mode: 'app', ...flags};
}

function requiredFlag(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function optionalResult(result) {
  return result === 'success' || result === 'skipped';
}

export function gatePasses({mode, classify, docs, lint, app, platform, npmPack, platformRequired, npmPackRequired}) {
  if (classify !== 'success' || docs !== 'success' || lint !== 'success') return false;
  const platformFlag = requiredFlag(platformRequired);
  const npmFlag = requiredFlag(npmPackRequired);
  if (platformFlag === null || npmFlag === null) return false;
  if (mode === 'docs') return !platformFlag && !npmFlag && optionalResult(app) && optionalResult(platform) && optionalResult(npmPack);
  if (mode === 'app') {
    return app === 'success'
      && (platformFlag ? platform === 'success' : optionalResult(platform))
      && (npmFlag ? npmPack === 'success' : optionalResult(npmPack));
  }
  if (mode === 'full') return platformFlag && npmFlag && app === 'success' && platform === 'success' && npmPack === 'success';
  return false;
}

function envFlag(name) {
  if (process.env[name] === 'true') return true;
  if (process.env[name] === 'false') return false;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const passed = gatePasses({
    mode: process.env.MODE,
    classify: process.env.CLASSIFY,
    docs: process.env.DOCS,
    lint: process.env.LINT,
    app: process.env.APP,
    platform: process.env.PLATFORM,
    npmPack: process.env.NPM_PACK,
    platformRequired: envFlag('PLATFORM_REQUIRED'),
    npmPackRequired: envFlag('NPM_PACK_REQUIRED'),
  });
  console.log(passed ? 'CI gate passed' : 'CI gate blocked: required verification did not succeed');
  process.exitCode = passed ? 0 : 1;
}
