import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Hooks } from "../hooks.js";
import { joinInside, listPackageFiles, sha256OfFile } from "../fsutil.js";
import { indexPackage } from "../catalog.js";
import { readAuthoredManifest, splitPackageId, type StoredManifest } from "../manifest.js";
import { assertValidPayload } from "../payload.js";
import { isVersionTaken, saveBlob, savePackage } from "../store.js";
import type { VerifyOutcome } from "../verify.js";
import { installDependencies, packageDirectory } from "./pull.js";

/** A directory path, or file names mapped to contents for agents that cannot write files. */
export type PublishSource = string | Record<string, string | object>;

export interface PublishResult {
  status: "accepted" | "rejected";
  id: string;
  version: string;
  digest?: string;
  reason: string;
}

async function withSourceDirectory<T>(source: PublishSource, work: (dir: string) => Promise<T>): Promise<T> {
  if (typeof source === "string") return work(resolve(source));

  const dir = await mkdtemp(join(tmpdir(), "handoff-inline-"));
  try {
    for (const [name, content] of Object.entries(source)) {
      const target = joinInside(dir, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildStoredManifest(packageDir: string): Promise<StoredManifest> {
  const authored = await readAuthoredManifest(packageDir);
  const identity = splitPackageId(authored.id);
  const listed = await listPackageFiles(packageDir);
  await assertValidPayload(identity, packageDir, listed);
  const files = await Promise.all(
    listed.map(async ({ path, size }) => ({ path, size, hash: await sha256OfFile(joinInside(packageDir, path)) })),
  );
  return {
    ...authored,
    type: identity.type,
    files,
    provenance: { author: process.env.HANDOFF_AGENT_ID ?? "unknown", created: new Date().toISOString() },
  };
}

/** Verifies in a throwaway workspace laid out like a consumer's: dependencies installed next to the package. */
async function verifyInScratchWorkspace(
  storeRoot: string,
  packageDir: string,
  manifest: StoredManifest,
  hooks: Hooks,
): Promise<VerifyOutcome> {
  const scratch = await mkdtemp(join(tmpdir(), "handoff-verify-"));
  try {
    const target = packageDirectory(scratch, manifest.id);
    await cp(packageDir, target, { recursive: true });
    await installDependencies(storeRoot, scratch, manifest.deps);
    return await hooks.verify({ manifest, packageDir: target });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function publishPackage(storeRoot: string, source: PublishSource, hooks: Hooks): Promise<PublishResult> {
  return withSourceDirectory(source, async (packageDir) => {
    const manifest = await buildStoredManifest(packageDir);
    const identity = { id: manifest.id, version: manifest.version };

    if (await isVersionTaken(storeRoot, manifest.id, manifest.version)) {
      throw new Error(`${manifest.id}@${manifest.version} already exists; versions are immutable, publish a new version`);
    }

    const outcome = await verifyInScratchWorkspace(storeRoot, packageDir, manifest, hooks);
    if (!outcome.ok) {
      const timeoutNote = outcome.timedOut ? " (timed out)" : "";
      return { ...identity, status: "rejected", reason: `Verification failed${timeoutNote}:\n${outcome.outputTail}` };
    }

    const decision = await hooks.review({ manifest, packageDir });
    if (!decision.approved) return { ...identity, status: "rejected", reason: decision.reason };

    await Promise.all(
      manifest.files.map((file) => saveBlob(storeRoot, joinInside(packageDir, file.path), file.hash)),
    );
    const saved = await savePackage(storeRoot, manifest);
    await indexPackage(storeRoot, manifest);
    return { ...identity, status: "accepted", digest: saved.digest, reason: decision.reason };
  });
}
