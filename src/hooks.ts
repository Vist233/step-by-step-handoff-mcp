import { runVerify, type VerifyOutcome } from "./verify.js";
import type { StoredManifest } from "./manifest.js";

export interface HookContext {
  manifest: StoredManifest;
  /** The package laid out as a consumer would see it: dependencies are installed next to it. */
  packageDir: string;
}

export interface ReviewDecision {
  approved: boolean;
  reason: string;
}

/** Re-checks a package. It may run a command, call an LLM, or do anything else. */
export type VerifyFn = (context: HookContext) => Promise<VerifyOutcome>;

/** Decides whether a package may be published. Replace it to add lint, secret scans or an LLM judge. */
export type ReviewFn = (context: HookContext) => Promise<ReviewDecision>;

export interface Hooks {
  verify: VerifyFn;
  review: ReviewFn;
}

/** Runs the command declared in handoff.json. Packages without one are skipped, not failed. */
export const defaultVerify: VerifyFn = async ({ manifest, packageDir }) => {
  if (!manifest.verify) return { ok: true, skipped: true, exitCode: null, timedOut: false, outputTail: "" };
  return runVerify(packageDir, manifest.verify);
};

/** The review is empty by default: every package that passes verification is accepted. */
export const defaultReview: ReviewFn = async () => ({ approved: true, reason: "No review configured" });

export const defaultHooks: Hooks = { verify: defaultVerify, review: defaultReview };
