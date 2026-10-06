/**
 * The ton-watch service and CLI as a module. JSR packages have no `bin`, so an
 * installed `@ton/watch` is run through a one-line file of your own:
 *
 *   // ton-watch.ts
 *   import { run } from "@ton/watch/cli";
 *   await run();
 *
 *   bun run ton-watch.ts run          # the service
 *   bun run ton-watch.ts add EQ…      # any other command
 *
 * Commands and environment variables are those of the `ton-watch` CLI (README,
 * "Service").
 *
 * @module
 */
import { errorMessage } from "./core/errors";
import { main } from "./service/cli";
import { consoleLogger } from "./util/logger";

/**
 * Runs one `ton-watch` command, by default the one on this process's command
 * line, configured from `process.env`. Long-running commands (`run`, `deliver`)
 * return once the service is up and exit the process on SIGINT/SIGTERM; the
 * others exit the process when done. A failure is logged and exits with code 1.
 */
export async function run(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    await main(argv, env);
  } catch (error) {
    consoleLogger("error").error(errorMessage(error));
    process.exit(1);
  }
}
