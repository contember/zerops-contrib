#!/usr/bin/env bun
/** Connects to 127.0.0.1:<port> and prints what answers there (the fake wireproxy's PONG line). */
const port = Number(process.argv[2]);
let got = "";
await new Promise<void>((resolve, reject) => {
  Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_s, d) => void (got += d.toString()),
      close: () => resolve(),
      error: (_s, err) => reject(err),
    },
  }).catch(reject);
});
console.log(got.trim());
