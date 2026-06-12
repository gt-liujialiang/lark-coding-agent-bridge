import { defineConfig } from 'vitest/config'

// maxForks caps memory usage: each vitest worker loads the full dep graph
// (~4GB here), and the default of one worker per CPU core OOMs a 10-core box,
// especially when multiple Claude Code subagents run tests concurrently.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
  },
})
