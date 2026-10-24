import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicationEligibility } from './source-materials.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export function parseReleaseValidationArgs(args) {
  if (args.length !== 3) throw new Error('Usage: validate-release.mjs <payload-root> <platform-arch> <app-version>');
  if (!/^(?:win32|darwin|linux)-(?:x64|arm64)$/.test(args[1])) throw new Error(`Unsupported release target: ${args[1]}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args[2])) throw new Error(`Invalid application version: ${args[2]}`);
  return { payloadRoot: path.resolve(args[0]), expectedTarget: args[1], expectedAppVersion: args[2] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseReleaseValidationArgs(process.argv.slice(2));
    const trustedManifest = path.join(scriptDir, 'tools-manifest.json');
    const result = await validatePublicationEligibility(args.payloadRoot, { ...args, toolsManifestPath: trustedManifest });
    process.stdout.write(`Release eligible: ${result.target} ${result.appVersion}; ${result.materialCount} source materials, ${result.noticeCount} notices\n`);
  } catch (error) {
    process.stderr.write(`Release blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
