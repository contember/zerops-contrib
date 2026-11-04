#!/usr/bin/env bun
/**
 * A command that counts the SIGINTs it receives. Writes its process group to argv[3] first (the
 * test sends its Ctrl-C there), then after 2s writes the count to argv[2] and exits.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [countFile, pgidFile] = process.argv.slice(2) as [string, string];
let count = 0;
process.on("SIGINT", () => count++);

function processGroup(): number {
  if (process.platform === "linux") {
    const stat = readFileSync("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  }
  return Number(Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim());
}

writeFileSync(pgidFile, String(processGroup()));
await Bun.sleep(2000);
writeFileSync(countFile, String(count));
