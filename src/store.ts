import { copyFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { STORE_DIR_NAME } from "./constants.js";
import { sha256OfText, writeFileAtomic } from "./fsutil.js";
import { splitPackageId, storedManifestSchema, type StoredManifest } from "./manifest.js";
import { compareVersions } from "./versions.js";

export interface StoredPackage {
  manifest: StoredManifest;
  /** sha256 of the stored manifest file; usable as a dependency pin. */
  digest: string;
}

export function resolveStoreRoot(): string {
  if (process.env.HANDOFF_STORE) return process.env.HANDOFF_STORE;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), STORE_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", STORE_DIR_NAME);
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), STORE_DIR_NAME);
}

export function blobPath(storeRoot: string, hash: string): string {
  return join(storeRoot, "blobs", hash);
}

function packageDirectoryInStore(storeRoot: string, id: string): string {
  const { type, name } = splitPackageId(id);
  return join(storeRoot, "packages", type, name);
}

function manifestPath(storeRoot: string, id: string, version: string): string {
  return join(packageDirectoryInStore(storeRoot, id), `${version}.json`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function saveBlob(storeRoot: string, sourcePath: string, hash: string): Promise<void> {
  const target = blobPath(storeRoot, hash);
  if (await exists(target)) return;
  await mkdir(join(storeRoot, "blobs"), { recursive: true });
  const tempPath = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await copyFile(sourcePath, tempPath);
  await rename(tempPath, target);
}

export async function savePackage(storeRoot: string, manifest: StoredManifest): Promise<StoredPackage> {
  const text = JSON.stringify(manifest, null, 2);
  await writeFileAtomic(manifestPath(storeRoot, manifest.id, manifest.version), text);
  return { manifest, digest: sha256OfText(text) };
}

export function isVersionTaken(storeRoot: string, id: string, version: string): Promise<boolean> {
  return exists(manifestPath(storeRoot, id, version));
}

async function readStoredPackage(path: string): Promise<StoredPackage> {
  const text = await readFile(path, "utf8");
  return { manifest: storedManifestSchema.parse(JSON.parse(text)), digest: sha256OfText(text) };
}

async function listDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listVersionsOf(storeRoot: string, id: string): Promise<StoredPackage[]> {
  const directory = packageDirectoryInStore(storeRoot, id);
  const files = await readdir(directory).catch(() => []);
  return Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readStoredPackage(join(directory, file))));
}

/** Every stored package version. Only used to rebuild the search catalog. */
export async function listAllPackages(storeRoot: string): Promise<StoredPackage[]> {
  const root = join(storeRoot, "packages");
  const found: StoredPackage[] = [];
  for (const type of await listDirectories(root)) {
    for (const name of await listDirectories(join(root, type))) {
      found.push(...(await listVersionsOf(storeRoot, `${type}/${name}`)));
    }
  }
  return found;
}

export async function findPackage(storeRoot: string, id: string, version?: string): Promise<StoredPackage> {
  if (version) {
    return readStoredPackage(manifestPath(storeRoot, id, version)).catch(() => {
      throw new Error(`Package not found: ${id}@${version}`);
    });
  }
  const latest = (await listVersionsOf(storeRoot, id)).sort((a, b) =>
    compareVersions(b.manifest.version, a.manifest.version),
  )[0];
  if (!latest) throw new Error(`Package not found: ${id}`);
  return latest;
}
