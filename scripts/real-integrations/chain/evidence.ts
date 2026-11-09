import { TapeCiError } from "@tapeci/shared";

const SECRET_KEY_PATTERN =
  /(?:private.?key|secret|mnemonic|seed.?phrase|authorization|password|api.?key|access.?token)/iu;

export function findSecretPaths(
  value: unknown,
  path = "$",
  found: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSecretPaths(entry, `${path}[${index}]`, found));
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (SECRET_KEY_PATTERN.test(key)) found.push(childPath);
      findSecretPaths(child, childPath, found);
    }
  }
  return found.sort();
}

export function stableEvidenceJson(value: unknown): string {
  const secretPaths = findSecretPaths(value);
  if (secretPaths.length > 0) {
    throw new TapeCiError(
      "INVALID_CONFIG",
      "evidence contains sensitive fields and was not written",
      { details: { fields: secretPaths } },
    );
  }
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
