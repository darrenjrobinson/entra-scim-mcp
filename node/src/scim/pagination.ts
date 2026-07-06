import type { ScimListResponse } from "./types.js";

export interface NormalizedListResponse<T> {
  resources: T[];
  nextCursor?: string;
  totalResults?: number;
  itemsPerPage?: number;
}

// The Entra SCIM API returns the resources array as either "Resources" (canonical SCIM)
// or "resources" (some endpoints/examples). Normalize so consumers don't care.
export function normalizeListResponse<T>(
  raw: ScimListResponse<T> | undefined,
): NormalizedListResponse<T> {
  if (!raw) return { resources: [] };
  const resources = raw.Resources ?? raw.resources ?? [];
  return {
    resources,
    nextCursor: raw.nextCursor,
    totalResults: raw.totalResults,
    itemsPerPage: raw.itemsPerPage,
  };
}
