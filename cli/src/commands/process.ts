import type { CommandSpec } from "../lib/spec.ts";
import { waitForProcess, type ProcessInfo } from "../lib/process.ts";

const PROCESS_COLUMNS = [
  { key: "actionName", header: "ACTION" },
  { key: "id", header: "ID" },
  { key: "status", header: "STATUS" },
  { key: "created", header: "CREATED" },
  { key: "finished", header: "FINISHED" },
];

export const processCommands: CommandSpec[] = [
  {
    path: ["process", "list"],
    summary: "List recent platform operations for the project or a service.",
    description: "The audit trail: who deployed what, which restart failed, what is running right now.",
    args: [{ name: "service", description: "Restrict to one service. Defaults to the whole project." }],
    flags: [
      { name: "limit", type: "number", default: 25, description: "How many processes to return." },
      { name: "status", type: "string", placeholder: "<status>", description: "Filter by status: PENDING, RUNNING, FINISHED, FAILED, CANCELED." },
    ],
    examples: ["zops process list", "zops process list api --status FAILED --json"],
    operations: ["ListProjectProcesses", "ListServiceStackProcesses"],
    async run(ctx, parsed) {
      const limit = ctx.flag<number>("limit") ?? 25;
      const res = parsed.args[0]
        ? await ctx.api.call<{ items?: ProcessInfo[]; list?: ProcessInfo[] }>("ListServiceStackProcesses", {
            path: { id: await ctx.serviceId(parsed.args[0]) },
            query: { limit },
          })
        : await ctx.api.call<{ items?: ProcessInfo[]; list?: ProcessInfo[] }>("ListProjectProcesses", {
            path: { id: await ctx.projectId() },
            query: { limit },
          });
      let items = res.items ?? res.list ?? [];
      const status = ctx.flag<string>("status");
      if (status) items = items.filter((p) => p.status === status.toUpperCase());
      ctx.out.data(items, { columns: PROCESS_COLUMNS, quietField: "id", emptyMessage: "no processes" });
    },
  },
  {
    path: ["process", "get"],
    summary: "Show one process.",
    args: [{ name: "process-id", description: "Process id.", required: true }],
    operations: ["GetProcessDetails"],
    async run(ctx, parsed) {
      ctx.out.data(await ctx.api.call("GetProcessDetails", { path: { id: parsed.args[0]! } }));
    },
  },
  {
    path: ["process", "wait"],
    summary: "Block until a process finishes.",
    description: `Useful after a --no-wait command: exits 0 when the process reaches FINISHED, 8 if it fails
or is canceled, and 7 if --timeout elapses first.`,
    args: [{ name: "process-id", description: "Process id.", required: true }],
    examples: ["zops process wait 4bKq8vNwQ1yTbXZs2LpAcd --timeout 5m"],
    operations: ["GetProcessDetails"],
    async run(ctx, parsed) {
      const finished = await waitForProcess(ctx, parsed.args[0]!, { timeoutMs: ctx.timeoutMs });
      ctx.out.data(finished);
    },
  },
  {
    path: ["process", "cancel"],
    summary: "Cancel a running process.",
    destructive: true,
    args: [{ name: "process-id", description: "Process id.", required: true }],
    operations: ["CancelUserProcess"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      await ctx.confirm(`cancel process ${id}`);
      if (ctx.dryRun) return { dryRun: true, operation: "CancelUserProcess", processId: id };
      ctx.out.data(await ctx.api.call("CancelUserProcess", { path: { id } }));
    },
  },
];
