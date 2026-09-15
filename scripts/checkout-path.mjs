/**
 * Generated bundles contain dependency filenames such as "applescript.js".
 * Match the checkout root only as a complete path token, not as a substring.
 */
function isPathBoundary(character) {
  return (
    character === undefined ||
    character === "/" ||
    character === "\\" ||
    character === '"' ||
    character === "'" ||
    character === "`"
  );
}

export function containsCheckoutPath(contents, checkoutRoot) {
  if (checkoutRoot.length === 0) return false;
  let offset = contents.indexOf(checkoutRoot);
  while (offset !== -1) {
    const before = contents[offset - 1];
    const after = contents[offset + checkoutRoot.length];
    if (isPathBoundary(before) && isPathBoundary(after)) return true;
    offset = contents.indexOf(checkoutRoot, offset + checkoutRoot.length);
  }
  return false;
}
