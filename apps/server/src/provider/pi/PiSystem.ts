// @ts-nocheck — Isolates Node child_process usage for Pi provider health checks
// and text generation. Effect's ChildProcess API is designed for managed
// lifetimes; the stateless `pi --version` and `pi --print` invocations are
// simpler as plain execFile calls.
import { execFile, type ExecFileException } from "node:child_process";

/**
 * Run `pi --version` and return the trimmed stdout.
 */
export function runPiVersion(binaryPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      binaryPath,
      ["--version"],
      { env },
      (error: ExecFileException | null, stdout: string) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

/**
 * Run `pi --print --no-session <prompt>` and return the trimmed stdout.
 */
export function runPiPrint(input: {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  args: ReadonlyArray<string>;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      input.binaryPath,
      [...input.args, input.prompt],
      {
        cwd: input.cwd,
        env: input.env,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.on("error", reject);
  });
}
