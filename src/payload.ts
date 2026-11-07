import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageFile } from "./fsutil.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

async function assertSkillPayload(name: string, dir: string): Promise<void> {
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => {
    throw new Error("A skill package needs a SKILL.md file");
  });
  const frontmatter = FRONTMATTER_PATTERN.exec(text)?.[1] ?? "";
  if (!/^description:\s*\S/m.test(frontmatter)) throw new Error('SKILL.md frontmatter is missing "description"');
  const declaredName = /^name:\s*(\S+)/m.exec(frontmatter)?.[1];
  if (!declaredName) throw new Error('SKILL.md frontmatter is missing "name"');
  if (declaredName !== name) throw new Error(`SKILL.md name "${declaredName}" must equal the package name "${name}"`);
}

/** Type-specific checks. Types without a checker only need at least one file. */
export async function assertValidPayload(
  { type, name }: { type: string; name: string },
  dir: string,
  files: PackageFile[],
): Promise<void> {
  if (files.length === 0) throw new Error("Package has no files besides handoff.json");
  if (type === "skill") await assertSkillPayload(name, dir);
}
