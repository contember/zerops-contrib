/**
 * The body for `PUT service-stack/{id}/autoscaling`, and the check that it took.
 *
 * Three things about this endpoint are not in the spec, and each one used to reset a service:
 *
 * - **The spec's key names are wrong.** It types `customAutoscaling` with
 *   `verticalAutoscalingNullable` / `horizontalAutoscalingNullable`. The server ignores those keys,
 *   treats the block as empty and clears the service's own settings, answering 200 all the same.
 *   It reads `verticalAutoscaling` / `horizontalAutoscaling`, the keys the service DTO reports.
 * - **The write replaces the whole custom block.** A key left out is not "keep it", so every field
 *   is sent back, including the ones nobody asked to change.
 * - **`currentAutoscaling` is the resolved view**, with inherited values filled in from the
 *   service type or profile. `customAutoscaling` holds the service's own settings, `null` where a
 *   value is inherited. `cpuMode`, `startCpuCoreCount`, `swapEnabled` and `minFreeResource` are
 *   echoed from the own block, so an inherited value stays inherited instead of being pinned.
 *   The min/max limits and container counts are sent from the resolved view, which is what
 *   `zops scale get` shows: those numbers are what the service keeps.
 *
 * The write is queued, so a 200 means accepted. `verifyAutoscaling` re-reads the service until
 * the numbers show up and fails with a field-by-field diff when they do not.
 */
import type { Context } from "./context.ts";
import { ZopsError, EXIT, usage } from "./errors.ts";

export interface Resource {
  cpuCoreCount?: number | null;
  memoryGBytes?: number | null;
  diskGBytes?: number | null;
}

export interface MinFreeResource {
  cpuCoreCount: number | null;
  cpuCorePercent: number | null;
  memoryGBytes: number | null;
  memoryPercent: number | null;
}

export interface VerticalAutoscaling {
  cpuMode?: string | null;
  startCpuCoreCount?: number | null;
  swapEnabled?: boolean | null;
  minFreeResource?: MinFreeResource | null;
  minResource?: Resource | null;
  maxResource?: Resource | null;
}

export interface HorizontalAutoscaling {
  minContainerCount?: number | null;
  maxContainerCount?: number | null;
}

export interface AutoscalingBlock {
  verticalAutoscaling?: VerticalAutoscaling | null;
  horizontalAutoscaling?: HorizontalAutoscaling | null;
}

/** The autoscaling part of the service DTO (`GetServiceStack`). */
export interface ServiceAutoscaling {
  autoscalingProfileId?: string | null;
  autoscalingProfileOverrides?: unknown;
  customAutoscaling?: AutoscalingBlock | null;
  currentAutoscaling?: AutoscalingBlock | null;
}

/** What the server reads. `horizontalAutoscaling` is absent for a service with no container range. */
export interface AutoscalingRequest {
  autoscalingProfileId?: string | null;
  autoscalingProfileOverrides?: unknown;
  customAutoscaling: {
    verticalAutoscaling: {
      cpuMode: string | null;
      startCpuCoreCount: number | null;
      swapEnabled: boolean | null;
      minFreeResource: MinFreeResource;
      minResource: { cpuCoreCount: number | null; memoryGBytes: number | null; diskGBytes: number | null };
      maxResource: { cpuCoreCount: number | null; memoryGBytes: number | null; diskGBytes: number | null };
    };
    horizontalAutoscaling?: { minContainerCount: number | null; maxContainerCount: number | null };
  };
}

/** One flat view over the nested blocks, under the names `zops scale get` prints. */
export interface Limits {
  minCpu: number | null;
  maxCpu: number | null;
  minRamGB: number | null;
  maxRamGB: number | null;
  minDiskGB: number | null;
  maxDiskGB: number | null;
  minContainers: number | null;
  maxContainers: number | null;
  cpuMode: string | null;
  startCpuCoreCount: number | null;
  swapEnabled: boolean | null;
}

export type LimitField = keyof Limits;

/** What a caller asks to change. `undefined` keeps the current value. */
export type AutoscalingChanges = Partial<Limits> & { autoscalingProfileId?: string };

export const LIMIT_FIELDS: LimitField[] = [
  "minCpu", "maxCpu", "minRamGB", "maxRamGB", "minDiskGB", "maxDiskGB",
  "minContainers", "maxContainers", "cpuMode", "startCpuCoreCount", "swapEnabled",
];

const PAIRS: [LimitField, LimitField][] = [
  ["minCpu", "maxCpu"],
  ["minRamGB", "maxRamGB"],
  ["minDiskGB", "maxDiskGB"],
  ["minContainers", "maxContainers"],
];

const INHERITED_MIN_FREE: MinFreeResource = {
  cpuCoreCount: null,
  cpuCorePercent: null,
  memoryGBytes: null,
  memoryPercent: null,
};

export function limitsOf(block: AutoscalingBlock | null | undefined): Limits {
  const v = block?.verticalAutoscaling;
  const h = block?.horizontalAutoscaling;
  return {
    minCpu: v?.minResource?.cpuCoreCount ?? null,
    maxCpu: v?.maxResource?.cpuCoreCount ?? null,
    minRamGB: v?.minResource?.memoryGBytes ?? null,
    maxRamGB: v?.maxResource?.memoryGBytes ?? null,
    minDiskGB: v?.minResource?.diskGBytes ?? null,
    maxDiskGB: v?.maxResource?.diskGBytes ?? null,
    minContainers: h?.minContainerCount ?? null,
    maxContainers: h?.maxContainerCount ?? null,
    cpuMode: v?.cpuMode ?? null,
    startCpuCoreCount: v?.startCpuCoreCount ?? null,
    swapEnabled: v?.swapEnabled ?? null,
  };
}

/** Whether Zerops states a container range for the service. A managed database reports none. */
export function hasContainerRange(service: ServiceAutoscaling): boolean {
  const h = service.currentAutoscaling?.horizontalAutoscaling;
  return h?.minContainerCount != null || h?.maxContainerCount != null;
}

/**
 * The complete body: the current configuration with `changes` merged in.
 *
 * A profile change is the one exception to "limits come from the resolved view": pinning the old
 * profile's resolved numbers would keep the new profile from applying, so then only the service's
 * own limits are sent and inherited ones stay `null`.
 */
export function autoscalingBody(service: ServiceAutoscaling, changes: AutoscalingChanges): AutoscalingRequest {
  const own = limitsOf(service.customAutoscaling);
  const resolved = limitsOf(service.currentAutoscaling);
  const ownVertical = service.customAutoscaling?.verticalAutoscaling;
  const profileChanges = changes.autoscalingProfileId !== undefined
    && changes.autoscalingProfileId !== (service.autoscalingProfileId ?? null);
  const base = profileChanges ? own : resolved;

  const pick = <K extends LimitField>(field: K, from: Limits): Limits[K] =>
    changes[field] !== undefined ? (changes[field] as Limits[K]) : from[field];

  const body: AutoscalingRequest = {
    customAutoscaling: {
      verticalAutoscaling: {
        cpuMode: pick("cpuMode", own),
        startCpuCoreCount: pick("startCpuCoreCount", own),
        swapEnabled: pick("swapEnabled", own),
        // Not nullable as a whole, so "inherited" is spelled per field, as the DTO does.
        minFreeResource: ownVertical?.minFreeResource ?? { ...INHERITED_MIN_FREE },
        minResource: {
          cpuCoreCount: pick("minCpu", base),
          memoryGBytes: pick("minRamGB", base),
          diskGBytes: pick("minDiskGB", base),
        },
        maxResource: {
          cpuCoreCount: pick("maxCpu", base),
          memoryGBytes: pick("maxRamGB", base),
          diskGBytes: pick("maxDiskGB", base),
        },
      },
    },
  };

  const containersAsked = changes.minContainers !== undefined || changes.maxContainers !== undefined;
  if (hasContainerRange(service) || containersAsked) {
    body.customAutoscaling.horizontalAutoscaling = {
      minContainerCount: pick("minContainers", base),
      maxContainerCount: pick("maxContainers", base),
    };
  }

  // Echoed only when the DTO carries them: an explicit null where there was no key is a change.
  if (changes.autoscalingProfileId !== undefined) body.autoscalingProfileId = changes.autoscalingProfileId;
  else if (service.autoscalingProfileId !== undefined) body.autoscalingProfileId = service.autoscalingProfileId;
  if (service.autoscalingProfileOverrides !== undefined) body.autoscalingProfileOverrides = service.autoscalingProfileOverrides;

  return body;
}

/**
 * Rejects what holds for every service type before anything is sent: positive numbers, whole
 * cores and containers, min not above max. The per-type limits are the platform's to enforce.
 */
export function checkLimits(body: AutoscalingRequest): void {
  const limits = limitsOf(body.customAutoscaling);
  const whole = new Set<LimitField>(["minCpu", "maxCpu", "minContainers", "maxContainers", "startCpuCoreCount"]);
  for (const field of LIMIT_FIELDS) {
    const value = limits[field];
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value) || value <= 0) {
      throw usage(`${field} must be greater than zero, got ${value}`, "Run `zops scale get` to see the current values.");
    }
    if (whole.has(field) && !Number.isInteger(value)) {
      throw usage(`${field} must be a whole number, got ${value}`);
    }
  }
  for (const [min, max] of PAIRS) {
    const lo = limits[min];
    const hi = limits[max];
    if (typeof lo === "number" && typeof hi === "number" && lo > hi) {
      throw usage(
        `${min} ${lo} is above ${max} ${hi}`,
        `Pass both ends, or move the other one too. Run \`zops scale get\` to see the current values.`,
      );
    }
  }
}

/**
 * The values the read-back must show. A field sent as `null` is inherited, and its resolved value
 * is the type's or the profile's to decide, so it is not checked.
 */
export function intendedLimits(body: AutoscalingRequest): Partial<Limits> {
  const sent = limitsOf(body.customAutoscaling);
  const hasRange = body.customAutoscaling.horizontalAutoscaling !== undefined;
  const intended: Partial<Limits> = {};
  for (const field of LIMIT_FIELDS) {
    if (!hasRange && (field === "minContainers" || field === "maxContainers")) continue;
    const value = sent[field];
    if (value !== null) (intended as Record<string, unknown>)[field] = value;
  }
  return intended;
}

export interface FieldDiff {
  field: string;
  wanted: unknown;
  actual: unknown;
}

/** Floats come back through JSON and the platform; a number that reads the same is the same. */
function same(wanted: unknown, actual: unknown): boolean {
  if (typeof wanted === "number" && typeof actual === "number") return Math.abs(wanted - actual) < 1e-6;
  return wanted === actual;
}

export function autoscalingDiff(body: AutoscalingRequest, service: ServiceAutoscaling): FieldDiff[] {
  const actual = limitsOf(service.currentAutoscaling);
  const diff: FieldDiff[] = [];
  for (const [field, wanted] of Object.entries(intendedLimits(body))) {
    const got = actual[field as LimitField];
    if (!same(wanted, got)) diff.push({ field, wanted, actual: got });
  }
  if (body.autoscalingProfileId !== undefined && (service.autoscalingProfileId ?? null) !== body.autoscalingProfileId) {
    diff.push({ field: "autoscalingProfileId", wanted: body.autoscalingProfileId, actual: service.autoscalingProfileId ?? null });
  }
  return diff;
}

/** `field: from → to` for every value the body changes, for plans and dry runs. */
export function describeChanges(body: AutoscalingRequest, service: ServiceAutoscaling): string[] {
  const before = limitsOf(service.currentAutoscaling);
  const lines: string[] = [];
  for (const [field, wanted] of Object.entries(intendedLimits(body))) {
    const was = before[field as LimitField];
    if (!same(wanted, was)) lines.push(`${field} ${was ?? "-"} → ${wanted}`);
  }
  if (body.autoscalingProfileId !== undefined && body.autoscalingProfileId !== (service.autoscalingProfileId ?? null)) {
    lines.push(`autoscalingProfileId ${service.autoscalingProfileId ?? "-"} → ${body.autoscalingProfileId}`);
  }
  return lines;
}

/** How long the read-back waits for a queued change to show, at most. */
const SETTLE_MS = 60_000;

/**
 * Re-reads the service until it reports what was sent, and throws (exit 8) with the fields that
 * still differ when it does not within the settle window or `--timeout`, whichever is shorter.
 */
export async function verifyAutoscaling(
  ctx: Context,
  serviceId: string,
  serviceName: string,
  body: AutoscalingRequest,
): Promise<ServiceAutoscaling> {
  const deadline = Date.now() + Math.min(SETTLE_MS, ctx.timeoutMs);
  for (;;) {
    const service = await ctx.api.call<ServiceAutoscaling>("GetServiceStack", { path: { id: serviceId } });
    const diff = autoscalingDiff(body, service);
    if (diff.length === 0) return service;
    if (Date.now() >= deadline) {
      const lines = diff.map((d) => `  ${d.field}: wanted ${d.wanted}, service reports ${d.actual ?? "-"}`);
      throw new ZopsError({
        code: "autoscalingNotApplied",
        message: `Zerops accepted the change but ${serviceName} does not report it:\n${lines.join("\n")}`,
        exitCode: EXIT.REMOTE_FAILED,
        hint: "Run `zops scale get` to see what the service has now, and `zops scale set` again with every value you need.",
        details: { service: serviceName, diff, body },
      });
    }
    await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}
