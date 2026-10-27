/** Compose files for building hub and web from this checkout. */
export const devComposeFileArgs = ["-f", "docker-compose.yml", "-f", "docker-compose.build.yml"];

export function devComposeUpArgs() {
  return ["compose", ...devComposeFileArgs, "up", "-d", "--build"];
}
