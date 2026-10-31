import path from "node:path";

/**
 * Whether `target` is `top` itself or lies inside it, judged lexically (no filesystem access).
 *
 * `path.relative` alone is not enough: it returns `"..foo/acct_x"` for a real directory named `..foo` inside
 * `top`, and a plain `relative.startsWith("..")` test then calls a contained path "outside". Every caller of
 * this predicate treats "outside" as "untrusted" (refuse the path, do not walk it, do not sync it), so the
 * mistake failed closed for safety but rejected legitimate paths — and in `AuthStore` it silently dropped
 * the ancestor-symlink walk for such a directory, which is a security check skipped rather than a path
 * refused. The parent directory is only `".."` itself or a path that starts with `".."` followed by a
 * separator; anything else that begins with two dots is an ordinary name.
 */
export function isWithin(top: string, target: string): boolean {
  const relative = path.relative(top, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
