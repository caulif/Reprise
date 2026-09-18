/** @returns {number[]} */
export function parseNodeVersion(version) {
  return version.split(".").map((part) => Number(part) || 0);
}

/** True when actual >= minimum, compared major → minor → patch. */
export function nodeVersionAtLeast(actualVersion, minimumParts) {
  const actual = parseNodeVersion(actualVersion);
  for (let index = 0; index < minimumParts.length; index += 1) {
    const minimum = minimumParts[index] ?? 0;
    const difference = (actual[index] ?? 0) - minimum;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** First `\d+\.\d+\.\d+` substring in CLI --version output. */
export function semverFromVersionOutput(output) {
  return output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
}
