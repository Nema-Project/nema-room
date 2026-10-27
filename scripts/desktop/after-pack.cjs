const { lstat, readdir, rm } = require('node:fs/promises');
const path = require('node:path');

const CANONICAL_SUFFIX = 'payload/runtime/licenses/electron/LICENSES.chromium.html';

async function findNotices(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || entry.isFile()) {
      if (entry.name === 'LICENSES.chromium.html') found.push(absolute);
      continue;
    }
    if (entry.isDirectory()) await findNotices(absolute, found);
  }
  return found;
}

/** Drop extra Chromium notices. The payload copy is the one source-materials checks. */
async function afterPack(context) {
  const root = context?.appOutDir;
  if (!root) throw new Error('afterPack is missing appOutDir');
  const notices = await findNotices(root);
  const canonical = notices.filter((file) => file.split(path.sep).join('/').endsWith(CANONICAL_SUFFIX));
  if (canonical.length !== 1) throw new Error('Refusing to remove Chromium notices: the payload copy is missing or duplicated');
  const info = await lstat(canonical[0]);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to remove Chromium notices: the payload copy is not a regular file');
  for (const file of notices) {
    if (file === canonical[0]) continue;
    await rm(file);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
