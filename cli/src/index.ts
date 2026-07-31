#!/usr/bin/env bun
import { run } from "./cli.ts";

// Piping into `head` closes stdout early; that is normal usage, not a crash.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = await run(process.argv.slice(2));
