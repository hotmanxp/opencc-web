#!/usr/bin/env node
import('../dist/cli/index.js').catch((err) => {
  console.error('[zai] Failed to start:', err);
  process.exit(1);
});
