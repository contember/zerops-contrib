#!/usr/bin/env bun
import { run } from "./cli.ts";
import { shutdown } from "./lib/shutdown.ts";

// Piping into `head` closes stdout early; that is normal usage, not a crash. A command with
// something to clean up (an open tunnel) is told instead, and exits once it has.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    if (shutdown.onBrokenPipe) shutdown.onBrokenPipe();
    else process.exit(0);
    return;
  }
  throw err;
});

process.exitCode = await run(process.argv.slice(2));
