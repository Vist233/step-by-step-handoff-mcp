import { OUTPUT_TAIL_CHARS } from "./constants.js";
import { runCommand } from "./command.js";
import { joinInside } from "./fsutil.js";
import type { VerifySpec } from "./manifest.js";

export interface VerifyOutcome {
  ok: boolean;
  /** True when the package declares no check; ok is then true but nothing was verified. */
  skipped?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

export async function runVerify(packageDir: string, spec: VerifySpec): Promise<VerifyOutcome> {
  const result = await runCommand({ cmd: spec.cmd, cwd: joinInside(packageDir, spec.cwd) });
  const combinedOutput = result.stdout + result.stderr;
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputTail: combinedOutput.slice(-OUTPUT_TAIL_CHARS),
  };
}
