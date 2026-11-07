import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DESCRIPTION_MAX_CHARS, MANIFEST_FILE_NAME, MAX_TAGS, NAME_MAX_CHARS } from "./constants.js";

const NAME_SEGMENT = `[a-z0-9][a-z0-9._-]{0,${NAME_MAX_CHARS - 1}}`;
const PACKAGE_ID_PATTERN = new RegExp(`^${NAME_SEGMENT}/${NAME_SEGMENT}$`, "i");
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const dependencySchema = z.object({
  id: z.string().regex(PACKAGE_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN).optional(),
  /** Optional pin: sha256 of the dependency's stored manifest. */
  digest: z.string().regex(SHA256_PATTERN).optional(),
});

const verifySchema = z.object({
  cmd: z.array(z.string()).min(1),
  cwd: z.string().default("."),
});

/** What a producer writes into handoff.json. */
export const authoredManifestSchema = z.object({
  id: z.string().regex(PACKAGE_ID_PATTERN),
  version: z.string().regex(VERSION_PATTERN),
  description: z.string().min(1).max(DESCRIPTION_MAX_CHARS),
  tags: z.array(z.string().regex(TAG_PATTERN)).max(MAX_TAGS).default([]),
  deps: z.array(dependencySchema).default([]),
  verify: verifySchema.optional(),
});

/** What the store keeps: the authored fields plus computed ones. */
export const storedManifestSchema = authoredManifestSchema.extend({
  type: z.string(),
  files: z.array(z.object({ path: z.string(), hash: z.string().regex(SHA256_PATTERN), size: z.number() })),
  provenance: z.object({ author: z.string(), created: z.string() }),
});

export type AuthoredManifest = z.infer<typeof authoredManifestSchema>;
export type StoredManifest = z.infer<typeof storedManifestSchema>;
export type VerifySpec = z.infer<typeof verifySchema>;

export async function readAuthoredManifest(packageDir: string): Promise<AuthoredManifest> {
  const text = await readFile(join(packageDir, MANIFEST_FILE_NAME), "utf8").catch(() => {
    throw new Error(`${MANIFEST_FILE_NAME} is missing; every package needs it`);
  });
  return authoredManifestSchema.parse(JSON.parse(text));
}

export function splitPackageId(id: string): { type: string; name: string } {
  const [type = "", name = ""] = id.split("/");
  return { type, name };
}

/** Accepts "type/name" or "type/name@1.2.0". */
export function parsePackageRef(ref: string): { id: string; version?: string } {
  const [id = "", version] = ref.split("@");
  if (!PACKAGE_ID_PATTERN.test(id)) throw new Error(`Invalid package id "${id}"; expected type/name or type/name@1.2.0`);
  if (version !== undefined && !VERSION_PATTERN.test(version)) throw new Error(`Invalid version "${version}"; expected 1.2.3`);
  return version === undefined ? { id } : { id, version };
}
