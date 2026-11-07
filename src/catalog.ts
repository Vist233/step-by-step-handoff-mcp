import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { REFINE_SCAN_ROWS } from "./constants.js";
import type { StoredManifest } from "./manifest.js";
import { listAllPackages } from "./store.js";
import { compareVersions } from "./versions.js";

/**
 * Search index over the stored manifests. The JSON manifests stay the source of truth;
 * this SQLite file can be deleted and is rebuilt on the next open. WAL mode lets many
 * agent processes read and write the same catalog.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
    description TEXT NOT NULL, tags TEXT NOT NULL, content_key TEXT NOT NULL,
    verifiable INTEGER NOT NULL, versions TEXT NOT NULL, created TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS packages_type ON packages(type);
  CREATE INDEX IF NOT EXISTS packages_content ON packages(content_key);
`;

export interface ParsedQuery {
  type?: string;
  tags: string[];
  words: string[];
}

export interface CatalogHit {
  id: string;
  type: string;
  version: string;
  versions: string[];
  description: string;
  tags: string[];
  verifiable: boolean;
  /** Other packages with byte-identical content that were folded into this one. */
  duplicates: number;
}

export interface CatalogResult {
  total: number;
  hits: CatalogHit[];
  typeCounts: Record<string, number>;
  tagCounts: Record<string, number>;
}

/** Splits "type:lemma tag:group some words" into filters and free words. */
export function parseQuery(query: string | undefined): ParsedQuery {
  const parsed: ParsedQuery = { tags: [], words: [] };
  for (const token of (query ?? "").toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("type:") && token.length > 5) parsed.type = token.slice(5);
    else if (token.startsWith("tag:") && token.length > 4) parsed.tags.push(token.slice(4));
    else parsed.words.push(token);
  }
  return parsed;
}

function contentKeyOf(manifest: StoredManifest): string {
  const lines = manifest.files.map((file) => `${file.path}:${file.hash}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function toTagColumn(tags: string[]): string {
  return tags.length === 0 ? "" : ` ${tags.join(" ")} `;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function containsPattern(text: string): string {
  return `%${escapeLike(text)}%`;
}

function upsert(db: DatabaseSync, manifest: StoredManifest): void {
  const existing = db.prepare("SELECT version, versions FROM packages WHERE id = ?").get(manifest.id) as
    | { version: string; versions: string }
    | undefined;
  const versions = [...new Set([...(existing ? (JSON.parse(existing.versions) as string[]) : []), manifest.version])];
  versions.sort(compareVersions);
  if (existing && compareVersions(manifest.version, existing.version) < 0) {
    db.prepare("UPDATE packages SET versions = ? WHERE id = ?").run(JSON.stringify(versions), manifest.id);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO packages
     (id, type, name, version, description, tags, content_key, verifiable, versions, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    manifest.id,
    manifest.type,
    manifest.id.split("/")[1] ?? "",
    manifest.version,
    manifest.description,
    toTagColumn(manifest.tags),
    contentKeyOf(manifest),
    manifest.verify ? 1 : 0,
    JSON.stringify(versions),
    manifest.provenance.created,
  );
}

async function openCatalog(storeRoot: string): Promise<DatabaseSync> {
  mkdirSync(storeRoot, { recursive: true });
  const db = new DatabaseSync(join(storeRoot, "catalog.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM packages").get() as { count: number };
  if (count === 0) await rebuild(db, storeRoot);
  return db;
}

async function rebuild(db: DatabaseSync, storeRoot: string): Promise<void> {
  const stored = await listAllPackages(storeRoot);
  db.exec("BEGIN IMMEDIATE");
  for (const { manifest } of stored) upsert(db, manifest);
  db.exec("COMMIT");
}

export async function indexPackage(storeRoot: string, manifest: StoredManifest): Promise<void> {
  const db = await openCatalog(storeRoot);
  try {
    db.exec("BEGIN IMMEDIATE");
    upsert(db, manifest);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

interface Filter {
  clause: string;
  params: SQLInputValue[];
}

function buildFilter({ type, tags, words }: ParsedQuery): Filter {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  for (const tag of tags) {
    clauses.push("tags LIKE ? ESCAPE '\\'");
    params.push(containsPattern(` ${tag} `));
  }
  for (const word of words) {
    clauses.push("(id LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(containsPattern(word), containsPattern(word), containsPattern(word));
  }
  return { clause: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
}

/** Relevance: a word in the id counts 3, in a tag 2, in the description 1. */
function buildScore(words: string[]): Filter {
  if (words.length === 0) return { clause: "0", params: [] };
  const params: SQLInputValue[] = [];
  const parts = words.map((word) => {
    params.push(containsPattern(word), containsPattern(word), containsPattern(word));
    return "((id LIKE ? ESCAPE '\\') * 3 + (tags LIKE ? ESCAPE '\\') * 2 + (description LIKE ? ESCAPE '\\'))";
  });
  return { clause: parts.join(" + "), params };
}

function countTags(rows: { tags: string }[], exclude: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { tags } of rows) {
    for (const tag of tags.split(" ").filter(Boolean)) {
      if (!exclude.includes(tag)) counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  return counts;
}

export async function searchCatalog(storeRoot: string, query: ParsedQuery, limit: number): Promise<CatalogResult> {
  const db = await openCatalog(storeRoot);
  try {
    const filter = buildFilter(query);
    const score = buildScore(query.words);

    const rows = db
      .prepare(
        `WITH matched AS (SELECT *, (${score.clause}) AS score FROM packages WHERE ${filter.clause}),
         ranked AS (
           SELECT matched.*,
                  ROW_NUMBER() OVER (PARTITION BY content_key ORDER BY score DESC, id) AS copy_rank,
                  COUNT(*) OVER (PARTITION BY content_key) AS copies
           FROM matched)
         SELECT * FROM ranked WHERE copy_rank = 1 ORDER BY score DESC, created DESC, id LIMIT ?`,
      )
      .all(...score.params, ...filter.params, limit) as Record<string, any>[];

    const { total } = db
      .prepare(`SELECT COUNT(DISTINCT content_key) AS total FROM packages WHERE ${filter.clause}`)
      .get(...filter.params) as { total: number };

    const typeRows = db
      .prepare(`SELECT type, COUNT(DISTINCT content_key) AS count FROM packages WHERE ${filter.clause} GROUP BY type`)
      .all(...filter.params) as { type: string; count: number }[];
    const tagRows = db
      .prepare(`SELECT tags FROM packages WHERE ${filter.clause} AND tags != '' LIMIT ${REFINE_SCAN_ROWS}`)
      .all(...filter.params) as { tags: string }[];

    return {
      total,
      hits: rows.map((row) => ({
        id: row.id,
        type: row.type,
        version: row.version,
        versions: JSON.parse(row.versions),
        description: row.description,
        tags: String(row.tags).split(" ").filter(Boolean),
        verifiable: row.verifiable === 1,
        duplicates: Number(row.copies) - 1,
      })),
      typeCounts: Object.fromEntries(typeRows.map(({ type, count }) => [type, count])),
      tagCounts: countTags(tagRows, query.tags),
    };
  } finally {
    db.close();
  }
}
