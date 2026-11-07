import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface PackageSpec {
  id: string;
  version?: string;
  description?: string;
  tags?: string[];
  files?: Record<string, string>;
  deps?: object[];
  verify?: { cmd: string[]; cwd?: string };
}

export const PASS = ["node", "-e", "process.exit(0)"];
export const FAIL = ["node", "-e", "console.error('nope'); process.exit(3)"];

export interface Workspace {
  storeRoot: string;
  workDir: string;
  sourceRoot: string;
}

export async function createWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(join(tmpdir(), "handoff-test-"));
  const workspace = { storeRoot: join(base, "store"), workDir: join(base, "work"), sourceRoot: join(base, "src") };
  await mkdir(workspace.sourceRoot, { recursive: true });
  await mkdir(workspace.workDir, { recursive: true });
  return workspace;
}

/** The files of a package as an object, usable for inline publishing. */
export function packageFiles(spec: PackageSpec): Record<string, string> {
  const manifest = {
    id: spec.id,
    version: spec.version ?? "1.0.0",
    description: spec.description ?? `Description of ${spec.id}`,
    tags: spec.tags ?? [],
    deps: spec.deps ?? [],
    verify: spec.verify,
  };
  return { "handoff.json": JSON.stringify(manifest), ...(spec.files ?? { "data.txt": "hello" }) };
}

export async function writePackage(sourceRoot: string, spec: PackageSpec): Promise<string> {
  const dir = await mkdtemp(join(sourceRoot, "pkg-"));
  for (const [name, content] of Object.entries(packageFiles(spec))) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}
