/**
 * Autoscaling configuration.
 *
 * The endpoint replaces the service's whole custom configuration, and the spec names its keys
 * wrong, so `scale set` reads the service, merges the flags into a complete body
 * (`lib/autoscaling.ts` says which value comes from where), sends it, and then reads the service
 * back to check the change took.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { usage } from "../lib/errors.ts";
import {
  autoscalingBody,
  checkLimits,
  describeChanges,
  limitsOf,
  verifyAutoscaling,
  type AutoscalingChanges,
  type ServiceAutoscaling,
} from "../lib/autoscaling.ts";

/** Flag name → the field it changes. */
const FLAG_FIELDS = {
  "min-cpu": "minCpu",
  "max-cpu": "maxCpu",
  "min-ram": "minRamGB",
  "max-ram": "maxRamGB",
  "min-disk": "minDiskGB",
  "max-disk": "maxDiskGB",
  "min-containers": "minContainers",
  "max-containers": "maxContainers",
  "cpu-mode": "cpuMode",
  "start-cpu": "startCpuCoreCount",
  swap: "swapEnabled",
  "autoscaling-profile": "autoscalingProfileId",
} as const satisfies Record<string, keyof AutoscalingChanges>;

export const scaleCommands: CommandSpec[] = [
  {
    path: ["scale", "get"],
    summary: "Show a service's current scaling configuration.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zops scale get api", "zops scale get api --json"],
    operations: ["GetServiceStack"],
    async run(ctx, parsed) {
      const service = (await ctx.service(parsed.args[0])) as ServiceAutoscaling & { name: string };
      ctx.out.data({
        service: service.name,
        autoscalingProfileId: service.autoscalingProfileId ?? null,
        ...limitsOf(service.currentAutoscaling),
      });
    },
  },
  {
    path: ["scale", "set"],
    summary: "Change a service's scaling limits.",
    description: `Only the values you pass change; everything else keeps its current setting.

zops reads the service, sends its complete configuration with your values merged in, and reads
it back: if the service does not report what was sent, it exits 8 and lists the fields that
differ. --dry-run prints the full body without sending it.

Runtime and Linux-container services scale horizontally between 1 and 10 containers. Managed
services have a fixed container count decided by their :single / :ha type and reject
--min-containers / --max-containers.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "min-cpu", type: "number", placeholder: "<cores>", description: "Minimum CPU cores." },
      { name: "max-cpu", type: "number", placeholder: "<cores>", description: "Maximum CPU cores." },
      { name: "min-ram", type: "number", placeholder: "<GB>", description: "Minimum RAM in GB (float allowed)." },
      { name: "max-ram", type: "number", placeholder: "<GB>", description: "Maximum RAM in GB (float allowed)." },
      { name: "min-disk", type: "number", placeholder: "<GB>", description: "Minimum disk in GB." },
      { name: "max-disk", type: "number", placeholder: "<GB>", description: "Maximum disk in GB." },
      { name: "min-containers", type: "number", placeholder: "<n>", description: "Minimum container count (1-10)." },
      { name: "max-containers", type: "number", placeholder: "<n>", description: "Maximum container count (1-10)." },
      { name: "cpu-mode", type: "string", enum: ["SHARED", "DEDICATED"], description: "SHARED is burstable and cheaper; DEDICATED reserves cores." },
      { name: "start-cpu", type: "number", placeholder: "<cores>", description: "Cores a fresh container starts with." },
      { name: "swap", type: "boolean", description: "Enable swap. Use --no-swap to disable." },
      // Not `--profile`: that is the global flag selecting a zops profile (organization).
      { name: "autoscaling-profile", type: "string", placeholder: "<id>", description: "Autoscaling profile id, e.g. oltp-production." },
    ],
    examples: [
      "zops scale set api --min-containers 2 --max-containers 5",
      "zops scale set api --max-cpu 8 --max-ram 16 --cpu-mode DEDICATED",
      "zops scale set db --autoscaling-profile oltp-production",
      "zops scale set api --max-cpu 4 --dry-run --json",
    ],
    operations: ["GetServiceStack", "ConfigureAutoscaling"],
    async run(ctx, parsed) {
      const changes: AutoscalingChanges = {};
      for (const [flag, field] of Object.entries(FLAG_FIELDS)) {
        if (ctx.flags[flag] === undefined) continue;
        (changes as Record<string, unknown>)[field] = flag === "swap" ? ctx.bool("swap") : ctx.flags[flag];
      }
      const touched = Object.keys(FLAG_FIELDS).filter((f) => ctx.flags[f] !== undefined);

      if (touched.length === 0) {
        throw usage(
          "nothing to change",
          "Pass at least one of --min-cpu, --max-cpu, --min-ram, --max-ram, --min-disk, --max-disk, --min-containers, --max-containers, --cpu-mode, --start-cpu, --swap, --autoscaling-profile. Run `zops scale get` to see current values.",
        );
      }

      const service = (await ctx.service(parsed.args[0])) as ServiceAutoscaling & { id: string; name: string };
      const body = autoscalingBody(service, changes);
      checkLimits(body);
      const planned = describeChanges(body, service);

      if (ctx.dryRun) {
        return { dryRun: true, operation: "ConfigureAutoscaling", service: service.name, changed: touched, changes: planned, body };
      }

      const proc = await ctx.api.call<{ id: string }>("ConfigureAutoscaling", {
        path: { id: service.id },
        body,
      });
      const settled = await settleProcess(ctx, proc, `rescaling ${service.name}`);
      if (!ctx.wait) {
        ctx.out.data({ ...settled, changes: planned, verified: false });
        return;
      }
      const after = await verifyAutoscaling(ctx, service.id, service.name, body);
      ctx.out.data({
        ...settled,
        changes: planned,
        verified: true,
        autoscalingProfileId: after.autoscalingProfileId ?? null,
        ...limitsOf(after.currentAutoscaling),
      });
    },
  },
];
