# Project guidance for Claude Code

## Running tests

This repo has ~96 vitest files and many integration/PTY tests. Default vitest
parallelism (one fork per CPU core, ~4GB each) will overwhelm the machine,
especially when multiple subagents run tests in parallel.

Rules for any Claude Code session or subagent:

- **Never run `vitest` in watch mode.** Always use `vitest run` (or the existing
  `pnpm test` / `pnpm test:unit` / `pnpm test:integration` / `pnpm test:process`
  scripts, which all use `vitest run`).
- **Run the narrowest scope possible.** If you only changed unit code, use
  `pnpm test:unit`. Only fall back to the full `pnpm test` when verifying
  end-to-end.
- **Do not invoke vitest from more than one subagent at a time.** If you
  dispatch parallel subagents, the test-running step must be serialized in the
  main agent, not delegated to each subagent.
- **Do not pass `--pool` / `--poolOptions` flags to override the config.** The
  project-wide cap (maxForks=4) in `vitest.config.ts` exists for a reason — see
  the comment in that file. If a test legitimately needs more workers, raise it
  in the config, don't bypass it on the command line.
