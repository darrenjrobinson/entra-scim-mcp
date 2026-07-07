// The Entra SCIM API rejects any whitespace (encoded or unencoded) immediately
// around the "=" in a query string. We build query strings by hand so that no
// helper accidentally introduces a space, and we strip leading/trailing
// whitespace from each key/value to fail fast if the caller passes one.

export type QueryParams = Record<string, string | number | undefined | null>;

export function buildQueryString(params: QueryParams | undefined): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (rawValue === undefined || rawValue === null) continue;
    assertNoSurroundingWhitespace("key", rawKey);
    const value = String(rawValue);
    assertNoSurroundingWhitespace("value", value);
    // SCIM filter values contain spaces and quotes; encodeURIComponent handles
    // both. We deliberately keep "=" unencoded with no padding.
    parts.push(`${encodeURIComponent(rawKey)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Server-side counterpart of the whitespace rule, for a raw (still
 * percent-encoded) query string: any whitespace — literal or encoded —
 * immediately around an "=" must be rejected with a 400, exactly like the
 * real API. Used by the mock server on req.url before decoding.
 */
export function assertRawQueryHasNoWhitespaceAroundEquals(rawQuery: string): void {
  const encodedWs = "(?:%09|%0A|%0D|%20)";
  const around = new RegExp(`(?:\\s|\\+|${encodedWs})=|=(?:\\s|\\+|${encodedWs})`, "i");
  if (around.test(rawQuery)) {
    throw new Error(
      'Whitespace (encoded or unencoded) around "=" in the query string is not allowed (Entra SCIM API constraint).',
    );
  }
}

function assertNoSurroundingWhitespace(label: string, s: string): void {
  if (s.length === 0) return;
  if (/^\s|\s$/.test(s)) {
    throw new Error(
      `Query ${label} has leading or trailing whitespace; the Entra SCIM API rejects whitespace around "=" in query strings.`,
    );
  }
}
