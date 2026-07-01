/**
 * Pure helper for the top-level `eval` command's delegation to `eval:local`.
 *
 * When `evalguard eval` runs against a local config (`--local`, or a `.yaml`/
 * `.yml` file), it re-dispatches to the `eval:local` sub-command. The set of
 * flags forwarded MUST stay in lockstep with `eval:local`'s own options —
 * otherwise a documented quickstart like `evalguard eval --local --verbose`
 * errors with "unknown option '--verbose'" because the flag was declared on
 * `eval` but never passed through (the real-user smoke that surfaced this bug).
 *
 * Extracted here as a pure, exported function so the forwarding contract is
 * unit-testable WITHOUT importing index.ts (which calls program.parse() on
 * import) or spawning the CLI.
 */
export interface EvalLocalForwardableOpts {
  model?: string;
  provider?: string;
  output?: string;
  verbose?: boolean;
  /** Commander sets this to false when `--no-cache` is passed. */
  cache?: boolean;
}

/**
 * Build the argv tail for `eval:local <file> …`, forwarding every flag that
 * `eval:local` understands. The leading element is always the resolved config
 * file path. Boolean flags are emitted only when truthy; `--no-cache` is emitted
 * only when caching was explicitly disabled (`cache === false`).
 */
export function buildEvalLocalArgs(file: string, opts: EvalLocalForwardableOpts): string[] {
  const args = [file];
  if (opts.model) args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.output) args.push("--output", opts.output);
  if (opts.verbose) args.push("--verbose");
  if (opts.cache === false) args.push("--no-cache");
  return args;
}
