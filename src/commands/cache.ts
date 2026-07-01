/**
 * `evalguard cache` — Manage the eval response cache.
 *
 * Subcommands:
 *   evalguard cache clear  — Remove all cached LLM responses
 *   evalguard cache stats  — Show cache size, entries, hit rate
 */
import { Command } from "commander";
import chalk from "chalk";

export function registerCache(program: Command): void {
  const cache = program
    .command("cache")
    .description("Manage the eval response cache");

  cache
    .command("clear")
    .description("Clear all cached LLM responses")
    .option("--dry-run", "Show how many entries WOULD be cleared without modifying the cache", false)
    .action(async (opts: { dryRun?: boolean }) => {
      const { EvalCache } = await import("@evalguard/core");
      const evalCache = new (EvalCache as any)();
      // E2 (2026-05-19): --dry-run reads the live stats but never
      // invokes .clear(). Useful for pre-flight checks before a
      // scheduled wipe in CI / cron jobs.
      if (opts.dryRun) {
        const stats = evalCache.getStats();
        console.log(
          `  ${chalk.dim("[dry-run]")} Would clear ${chalk.cyan(String(stats.entries))} cached entries (${formatBytes(stats.sizeBytes)}). No changes written.`,
        );
        return;
      }
      const removed = evalCache.clear();
      console.log(`  ${chalk.green("✓")} Cleared ${removed} cached entries.`);
    });

  cache
    .command("stats")
    .description("Show cache statistics")
    .action(async () => {
      const { EvalCache } = await import("@evalguard/core");
      const evalCache = new (EvalCache as any)();
      const stats = evalCache.getStats();

      console.log();
      console.log(chalk.bold("  Eval Cache Statistics"));
      console.log();
      console.log(`  Entries:    ${chalk.cyan(String(stats.entries))}`);
      console.log(`  Size:       ${chalk.cyan(formatBytes(stats.sizeBytes))}`);

      if (stats.oldestEntry) {
        console.log(`  Oldest:     ${chalk.dim(new Date(stats.oldestEntry).toLocaleString())}`);
      }
      if (stats.newestEntry) {
        console.log(`  Newest:     ${chalk.dim(new Date(stats.newestEntry).toLocaleString())}`);
      }

      if (stats.hits + stats.misses > 0) {
        console.log(`  Hits:       ${chalk.green(String(stats.hits))}`);
        console.log(`  Misses:     ${chalk.yellow(String(stats.misses))}`);
        console.log(`  Hit rate:   ${chalk.cyan((stats.hitRate * 100).toFixed(1) + "%")}`);
      } else {
        console.log(`  ${chalk.dim("No cache lookups in this session.")}`);
      }
      console.log();
    });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
