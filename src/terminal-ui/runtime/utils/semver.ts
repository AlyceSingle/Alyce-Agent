import { coerce, gte as semverGte, valid } from "semver";

export function gte(left: string, right: string): boolean {
  const leftVersion = valid(left) ?? coerce(left)?.version;
  const rightVersion = valid(right) ?? coerce(right)?.version;

  if (!leftVersion || !rightVersion) {
    return false;
  }

  return semverGte(leftVersion, rightVersion);
}
