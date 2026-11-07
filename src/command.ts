import { spawn } from "node:child_process";
import { COMMAND_OUTPUT_LIMIT_BYTES, COMMAND_TIMEOUT_MS } from "./constants.js";

export interface CommandRequest {
  cmd: string[];
  cwd: string;
  input?: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs an argv-style command without a shell. Output is capped and the run has a timeout. */
export function runCommand({ cmd, cwd, input }: CommandRequest): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const [program = "", ...args] = cmd;
    const child = spawn(program, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-COMMAND_OUTPUT_LIMIT_BYTES);

    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    const finish = (exitCode: number | null, extraStderr = "") => {
      clearTimeout(timer);
      resolveResult({ exitCode, stdout, stderr: stderr + extraStderr, timedOut });
    };

    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
