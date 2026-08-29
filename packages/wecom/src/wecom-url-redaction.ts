const PRIVATE_LINK_REPLACEMENT = "[私密链接已隐藏]";

const WORKSPACE_ID = "[A-Za-z0-9_-]{16,128}";
const PRIVATE_ROUTE_SEARCH = new RegExp(
  `/(?:chat|debug|share)/${WORKSPACE_ID}(?=/|[?#\\s<>()\\[\\]{}]|$)`,
  "iu",
);
const PRIVATE_ROUTE_PATH = new RegExp(
  `^/(?:chat|debug|share)/${WORKSPACE_ID}(?=\\/|[?#]|$)`,
  "iu",
);
const WORKSPACE_QUERY = new RegExp(
  `(?:^|[?&])workspaceId=${WORKSPACE_ID}(?=[&#\\s<>()\\[\\]{}]|$)`,
  "iu",
);
const WORKSPACE_ID_EXACT = new RegExp(`^${WORKSPACE_ID}$`, "iu");

const ABSOLUTE_URL_TOKEN =
  /(?:https?:\/\/|\/\/)[^\s<>"'`()\[\]{},;，。！？；：]+/giu;
const URIISH_TOKEN = /[^\s<>"'`()\[\]{},;，。！？；：]+/gu;
const TRAILING_PUNCTUATION = /([.,;:!?，。！？；：]+)$/u;

function decodeForInspection(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replaceAll("\\/", "/");
}

function containsPrivateRoute(value: string): boolean {
  return PRIVATE_ROUTE_SEARCH.test(decodeForInspection(value));
}

function containsPrivateWorkspaceQuery(value: string): boolean {
  return WORKSPACE_QUERY.test(decodeForInspection(value));
}

function isPrivateUrl(value: string): boolean {
  const inspected = decodeForInspection(value);
  if (containsPrivateRoute(inspected) || containsPrivateWorkspaceQuery(inspected)) {
    return true;
  }

  for (const candidate of [value, inspected]) {
    try {
      const parsed = new URL(candidate, "https://dscode.invalid");
      if (PRIVATE_ROUTE_PATH.test(decodeForInspection(parsed.pathname))) return true;
      for (const [key, queryValue] of parsed.searchParams) {
        if (
          key.toLowerCase() === "workspaceid" &&
          WORKSPACE_ID_EXACT.test(queryValue)
        ) {
          return true;
        }
        if (containsPrivateRoute(queryValue)) return true;
      }
    } catch {
      // Try the next representation, then let the relative-route pass decide.
    }
  }
  return false;
}

function splitTrailingPunctuation(value: string): {
  core: string;
  suffix: string;
} {
  const match = TRAILING_PUNCTUATION.exec(value);
  if (match === null || match[1] === undefined) {
    return { core: value, suffix: "" };
  }
  return {
    core: value.slice(0, -match[1].length),
    suffix: match[1],
  };
}

function redactUrlToken(value: string): string {
  const { core, suffix } = splitTrailingPunctuation(value);
  return isPrivateUrl(core)
    ? `${PRIVATE_LINK_REPLACEMENT}${suffix}`
    : value;
}

/**
 * Remove DSCode bearer URLs before text is sent through WeCom.
 *
 * Workspace IDs are intentionally constrained to the same URL-safe shape as
 * the Web UI configuration. We redact the browser routes (`chat`, `debug`,
 * `share`) and workspace-scoped query parameters, including URL-encoded and
 * protocol-relative forms. Other URLs remain untouched.
 */
export function redactWeComPrivateUrls(text: string): string {
  let redacted = text.replace(ABSOLUTE_URL_TOKEN, redactUrlToken);
  redacted = redacted.replace(URIISH_TOKEN, (token) => {
    const { core, suffix } = splitTrailingPunctuation(token);
    return isPrivateUrl(core)
      ? `${PRIVATE_LINK_REPLACEMENT}${suffix}`
      : token;
  });
  redacted = redacted.replace(PRIVATE_ROUTE_SEARCH, PRIVATE_LINK_REPLACEMENT);
  return redacted;
}
