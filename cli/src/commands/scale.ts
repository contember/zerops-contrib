/**
 * Autoscaling configuration.
 *
 * The API takes a nested `customAutoscaling` object where every field is nullable and null means
 * "inherit the profile". Sending a partial object would wipe the fields you left out, so a set
 * always reads the current configuration first and merges the requested changes into it.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";
import { usage } from "../lib/errors.ts";

interface Resource {
  cpuCoreCount?: number | null;
  memoryGBytes?: number | null;
  diskGBytes?: number | null;
}

interface VerticalAutoscaling {
  cpuMode?: string | null;
  minResource?: Resource;
  maxResource?: Resource;
  startCpuCoreCount?: number | null;
  swapEnabled?: boolean | null;
  minFreeResource?: Record<string, number | null>;
}

interface HorizontalAutoscaling {
  minContainerCount?: number | null;
  maxContainerCount?: number | null;
}

interface CurrentAutoscaling {
  verticalAutoscaling?: VerticalAutoscaling | null;
  horizontalAutoscaling?: HorizontalAutoscaling | null;
}

export const scaleCommands: CommandSpec[] = [
  {
    path: ["scale", "get"],
    summary: "Show a service's current scaling configuration.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz scale get api", "zz scale get api --json"],
    operations: ["GetServiceStack"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const current = (service.currentAutoscaling ?? {}) as CurrentAutoscaling;
      ctx.out.data({
        service: service.name,
        autoscalingProfileId: service.autoscalingProfileId ?? null,
        cpuMode: current.verticalAutoscaling?.cpuMode ?? null,
        minCpu: current.verticalAutoscaling?.minResource?.cpuCoreCount ?? null,
        maxCpu: current.verticalAutoscaling?.maxResource?.cpuCoreCount ?? null,
        minRamGB: current.verticalAutoscaling?.minResource?.memoryGBytes ?? null,
        maxRamGB: current.verticalAutoscaling?.maxResource?.memoryGBytes ?? null,
        minDiskGB: current.verticalAutoscaling?.minResource?.diskGBytes ?? null,
        maxDiskGB: current.verticalAutoscaling?.maxResource?.diskGBytes ?? null,
        minContainers: current.horizontalAutoscaling?.minContainerCount ?? null,
        maxContainers: current.horizontalAutoscaling?.maxContainerCount ?? null,
        startCpuCoreCount: current.verticalAutoscaling?.startCpuCoreCount ?? null,
        swapEnabled: current.verticalAutoscaling?.swapEnabled ?? null,
      });
    },
  },
  {
    path: ["scale", "set"],
    summary: "Change a service's scaling limits.",
    description: `Only the values you pass change; everything else keeps its current setting.

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
      { name: "profile", type: "string", placeholder: "<id>", description: "Autoscaling profile id, e.g. oltp-production." },
    ],
    examples: [
      "zz scale set api --min-containers 2 --max-containers 5",
      "zz scale set api --max-cpu 8 --max-ram 16 --cpu-mode DEDICATED",
      "zz scale set db --profile oltp-production",
      "zz scale set api --min-containers 2 --dry-run --json",
    ],
    operations: ["GetServiceStack", "ConfigureAutoscaling"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const current = (service.currentAutoscaling ?? {}) as CurrentAutoscaling;

      const num = (name: string) => ctx.flag<number>(name);
      const touched = [
        "min-cpu", "max-cpu", "min-ram", "max-ram", "min-disk", "max-disk",
        "min-containers", "max-containers", "cpu-mode", "start-cpu", "swap", "profile",
      ].filter((f) => ctx.flags[f] !== undefined);

      if (touched.length === 0) {
        throw usage(
          "nothing to change",
          "Pass at least one of --min-cpu, --max-cpu, --min-ram, --max-ram, --min-containers, --max-containers, --cpu-mode, --profile. Run `zz scale get` to see current values.",
        );
      }

      const vertical: VerticalAutoscaling = {
        cpuMode: ctx.flag<string>("cpu-mode") ?? current.verticalAutoscaling?.cpuMode ?? null,
        startCpuCoreCount: num("start-cpu") ?? current.verticalAutoscaling?.startCpuCoreCount ?? null,
        swapEnabled: ctx.flags.swap !== undefined ? ctx.bool("swap") : (current.verticalAutoscaling?.swapEnabled ?? null),
        minResource: {
          cpuCoreCount: num("min-cpu") ?? current.verticalAutoscaling?.minResource?.cpuCoreCount ?? null,
          memoryGBytes: num("min-ram") ?? current.verticalAutoscaling?.minResource?.memoryGBytes ?? null,
          diskGBytes: num("min-disk") ?? current.verticalAutoscaling?.minResource?.diskGBytes ?? null,
        },
        maxResource: {
          cpuCoreCount: num("max-cpu") ?? current.verticalAutoscaling?.maxResource?.cpuCoreCount ?? null,
          memoryGBytes: num("max-ram") ?? current.verticalAutoscaling?.maxResource?.memoryGBytes ?? null,
          diskGBytes: num("max-disk") ?? current.verticalAutoscaling?.maxResource?.diskGBytes ?? null,
        },
      };

      const horizontal: HorizontalAutoscaling = {
        minContainerCount: num("min-containers") ?? current.horizontalAutoscaling?.minContainerCount ?? null,
        maxContainerCount: num("max-containers") ?? current.horizontalAutoscaling?.maxContainerCount ?? null,
      };

      const body = {
        ...(ctx.flag<string>("profile") ? { autoscalingProfileId: ctx.flag<string>("profile") } : {}),
        customAutoscaling: {
          verticalAutoscalingNullable: vertical,
          horizontalAutoscalingNullable: horizontal,
        },
      };

      if (ctx.dryRun) {
        return { dryRun: true, operation: "ConfigureAutoscaling", service: service.name, changed: touched, body };
      }

      const proc = await ctx.api.call<{ id: string }>("ConfigureAutoscaling", {
        path: { id: service.id },
        body,
      });
      ctx.out.data(await settleProcess(ctx, proc, `rescaling ${service.name}`));
    },
  },
];
