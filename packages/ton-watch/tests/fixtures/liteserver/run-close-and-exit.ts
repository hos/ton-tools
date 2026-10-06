import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./close-and-exit.ts", import.meta.url));

export interface CloseAndExitResult {
  exitCode: number | null;
  /** From the `closed` line to the process exit; null if `closed` never came. */
  exitMsAfterClose: number | null;
  stderr: string;
}

/**
 * Spawns close-and-exit.ts and times how long the process lives after its
 * `close()` resolved. Kills it once `deadlineMs` have passed.
 */
export async function runCloseAndExit(
  env: Record<string, string>,
  deadlineMs: number,
): Promise<CloseAndExitResult> {
  const proc = Bun.spawn(["bun", SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => proc.kill(), deadlineMs);
  let closedAt: number | null = null;
  const stdout = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of proc.stdout) {
      text += decoder.decode(chunk);
      if (closedAt === null && text.includes("closed")) closedAt = performance.now();
    }
  })();
  const stderr = new Response(proc.stderr).text();
  try {
    const exitCode = await proc.exited;
    const exitedAt = performance.now();
    await stdout;
    return {
      exitCode,
      exitMsAfterClose: closedAt === null ? null : exitedAt - closedAt,
      stderr: await stderr,
    };
  } finally {
    clearTimeout(deadline);
    proc.kill();
  }
}
