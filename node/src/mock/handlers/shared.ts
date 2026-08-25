import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_LIST_RESPONSE,
} from "../../scim/types.js";
import { MockScimError } from "../errors.js";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

const EXTENSION_URNS = [
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
];

// -- pagination --------------------------------------------------------------

export interface PageParams {
  count?: string | null;
  cursor?: string | null;
  /** validator-compat only: 1-based index pagination */
  startIndex?: string | null;
}

export function paginate<T>(
  items: T[],
  params: PageParams,
  validatorCompat: boolean,
): { page: T[]; nextCursor?: string; startIndex?: number; totalResults: number } {
  const count = parseCount(params.count);
  let offset = 0;
  let usedIndex = false;

  if (params.cursor) {
    offset = decodeCursor(params.cursor);
  } else if (validatorCompat && params.startIndex) {
    const idx = Number(params.startIndex);
    if (!Number.isInteger(idx) || idx < 1) {
      throw new MockScimError(
        400,
        "startIndex must be a positive integer.",
        "invalidValue",
      );
    }
    offset = idx - 1;
    usedIndex = true;
  }

  const page = items.slice(offset, offset + count);
  const result: {
    page: T[];
    nextCursor?: string;
    startIndex?: number;
    totalResults: number;
  } = { page, totalResults: items.length };
  if (!usedIndex && offset + count < items.length) {
    result.nextCursor = encodeCursor(offset + count);
  }
  if (usedIndex) {
    result.startIndex = offset + 1;
  }
  return result;
}

function parseCount(raw: string | null | undefined): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAGE_SIZE;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new MockScimError(400, "count must be a positive integer.", "invalidValue");
  }
  return Math.min(count, MAX_PAGE_SIZE);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      o?: unknown;
    };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0) {
      return parsed.o;
    }
  } catch {
    // fall through
  }
  throw new MockScimError(400, "Invalid cursor.", "invalidValue");
}

/** Users/groups lists use lowercase `resources` (unlike /schemas). */
export function listResponseBody(
  resources: unknown[],
  extras: { nextCursor?: string; startIndex?: number; totalResults: number },
): Record<string, unknown> {
  return {
    schemas: [SCHEMA_LIST_RESPONSE],
    totalResults: extras.totalResults,
    itemsPerPage: resources.length,
    ...(extras.nextCursor ? { nextCursor: extras.nextCursor } : {}),
    ...(extras.startIndex !== undefined ? { startIndex: extras.startIndex } : {}),
    resources,
  };
}

// -- projection --------------------------------------------------------------

interface AttrPath {
  /** Extension URN, when the attribute is URN-qualified. */
  urn?: string;
  /** Remaining dotted segments (may be empty = whole extension). */
  segments: string[];
}

function parseAttrPath(raw: string): AttrPath {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  for (const urn of EXTENSION_URNS) {
    const u = urn.toLowerCase();
    if (lower === u) return { urn, segments: [] };
    if (lower.startsWith(`${u}:`) || lower.startsWith(`${u}.`)) {
      const rest = trimmed.slice(urn.length + 1);
      return { urn, segments: rest.split(".").filter(Boolean) };
    }
  }
  return { segments: trimmed.split(".").filter(Boolean) };
}

/**
 * Apply attributes / excludedAttributes projection. id, schemas and meta are
 * always returned; unknown attribute names simply match nothing.
 */
export function projectResource(
  resource: Record<string, unknown>,
  attributes: string | null | undefined,
  excludedAttributes: string | null | undefined,
): Record<string, unknown> {
  if (attributes) {
    const paths = attributes.split(",").map(parseAttrPath);
    const projected: Record<string, unknown> = {};
    for (const always of ["schemas", "id", "meta"]) {
      if (resource[always] !== undefined) projected[always] = resource[always];
    }
    for (const path of paths) {
      copyPath(resource, projected, path);
    }
    return projected;
  }
  if (excludedAttributes) {
    const clone = structuredClone(resource);
    for (const path of excludedAttributes.split(",").map(parseAttrPath)) {
      deletePath(clone, path);
    }
    return clone;
  }
  return resource;
}

function copyPath(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  path: AttrPath,
): void {
  const keys = path.urn ? [path.urn, ...path.segments] : path.segments;
  copyKeys(source, target, keys);
}

function copyKeys(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  keys: string[],
): void {
  if (keys.length === 0) return;
  const key = resolveKey(source, keys[0]!);
  if (!key) return;
  const value = source[key];
  if (value === undefined) return;
  if (keys.length === 1) {
    target[key] = value;
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const nested = (target[key] as Record<string, unknown> | undefined) ?? {};
  target[key] = nested;
  copyKeys(value as Record<string, unknown>, nested, keys.slice(1));
}

function deletePath(target: Record<string, unknown>, path: AttrPath): void {
  const keys = path.urn ? [path.urn, ...path.segments] : path.segments;
  let current: Record<string, unknown> = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = resolveKey(current, keys[i]!);
    const next = key ? current[key] : undefined;
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
  }
  const last = resolveKey(current, keys[keys.length - 1]!);
  if (last && last.toLowerCase() !== "id" && last.toLowerCase() !== "schemas") {
    delete current[last];
  }
}

function resolveKey(obj: Record<string, unknown>, name: string): string | undefined {
  if (name in obj) return name;
  const lower = name.toLowerCase();
  return Object.keys(obj).find((key) => key.toLowerCase() === lower);
}
