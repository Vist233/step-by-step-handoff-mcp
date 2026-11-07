import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import {
  MANIFEST_FILE_NAME,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_TOTAL_BYTES,
} from "./constants.js";

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

/** Joins a relative path onto root and refuses anything that escapes root. */
export function joinInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Absolute path not allowed: ${relativePath}`);
  }
  const rootPath = resolve(root);
  const joined = resolve(rootPath, relativePath);
  if (joined !== rootPath && !joined.startsWith(rootPath + sep)) {
    throw new Error(`Path escapes its directory: ${relativePath}`);
  }
  return joined;
}

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, filePath);
}

export interface PackageFile {
  path: string;
  size: number;
}

/** Lists regular files below dir (posix-style relative paths), enforcing size limits. */
export async function listPackageFiles(dir: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  let totalBytes = 0;

  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = posix.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (relativePath === MANIFEST_FILE_NAME) continue;
      const { size } = await lstat(join(dir, relativePath));
      if (size > MAX_FILE_BYTES) throw new Error(`File too large: ${relativePath}`);
      totalBytes += size;
      files.push({ path: relativePath, size });
      if (files.length > MAX_FILE_COUNT) throw new Error("Too many files in package");
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Package too large");
    }
  }

  await walk("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
