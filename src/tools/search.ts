import {
  DEFAULT_SEARCH_LIMIT,
  REFINE_TAG_COUNT,
  SEARCH_DESCRIPTION_CHARS,
  SEARCH_MAX_LIMIT,
  SEARCH_RESPONSE_BUDGET_CHARS,
} from "../constants.js";
import { parseQuery, searchCatalog } from "../catalog.js";

export interface SearchRequest {
  query?: string;
  limit?: number;
}

export interface SearchResponse {
  total: number;
  shown: number;
  results: {
    id: string;
    version: string;
    description: string;
    tags: string[];
    verifiable: boolean;
    otherVersions?: string[];
    duplicates?: number;
  }[];
  /** Present when nothing matched. */
  note?: string;
  /** Present only when there are more matches than shown: how to narrow the query. */
  refine?: { types: Record<string, number>; tags: Record<string, number>; advice: string };
}

function shorten(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function topEntries(counts: Record<string, number>, limit: number): Record<string, number> {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(sorted.slice(0, limit));
}

/**
 * Like a skill listing: id plus a short description per entry, hard-capped in total size.
 * Agents narrow a big result set with filters instead of paging through it.
 */
export async function searchPackages(storeRoot: string, request: SearchRequest): Promise<SearchResponse> {
  const limit = Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, SEARCH_MAX_LIMIT);
  const found = await searchCatalog(storeRoot, parseQuery(request.query), limit);

  const results: SearchResponse["results"] = [];
  let usedChars = 0;
  for (const hit of found.hits) {
    const entry = {
      id: hit.id,
      version: hit.version,
      description: shorten(hit.description, SEARCH_DESCRIPTION_CHARS),
      tags: hit.tags,
      verifiable: hit.verifiable,
      ...(hit.versions.length > 1 ? { otherVersions: hit.versions.filter((version) => version !== hit.version) } : {}),
      ...(hit.duplicates > 0 ? { duplicates: hit.duplicates } : {}),
    };
    usedChars += JSON.stringify(entry).length;
    if (usedChars > SEARCH_RESPONSE_BUDGET_CHARS && results.length > 0) break;
    results.push(entry);
  }

  const response: SearchResponse = { total: found.total, shown: results.length, results };
  if (found.total === 0) {
    response.note = "No package matches all of the words and filters. Try fewer or different words, or drop a filter.";
  }
  if (found.total > results.length) {
    response.refine = {
      types: found.typeCounts,
      tags: topEntries(found.tagCounts, REFINE_TAG_COUNT),
      advice: "Too many matches to list. Add more words, or filter with type:<type> and tag:<tag>.",
    };
  }
  return response;
}
