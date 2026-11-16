import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { autoscalingBody, type AutoscalingBlock, type ServiceAutoscaling } from "../lib/autoscaling.ts";

/**
 * `zops scale set` against a stand-in API that behaves the way the real one was seen to:
 *
 * - it reads `customAutoscaling.verticalAutoscaling` / `horizontalAutoscaling`;
 * - a body with the spec's `...Nullable` keys is read as an empty block, which clears the
 *   service's own settings and drops it to its type's defaults (still answering 200);
 * - `currentAutoscaling` is the own block with every `null` filled in from the type.
 *
 * The service shapes are `GetServiceStack` responses as recorded, names and ids replaced.
 */
const PROJECT_ID = "Pr0jectIdForScaleTest1";

type Service = ServiceAutoscaling & { id: string; name: string; status: string };

/** The runtime type's defaults: what a service read after its custom block was cleared. */
const RUNTIME_DEFAULTS: AutoscalingBlock = {
  horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 10 },
  verticalAutoscaling: {
    cpuMode: "SHARED",
    startCpuCoreCount: 1,
    swapEnabled: true,
    minFreeResource: { cpuCoreCount: 0.1, cpuCorePercent: 0, memoryGBytes: 0.25, memoryPercent: 25 },
    minResource: { cpuCoreCount: 1, memoryGBytes: 0.125, diskGBytes: 1 },
    maxResource: { cpuCoreCount: 8, memoryGBytes: 48, diskGBytes: 100 },
  },
};

/** The case that was reported: a runtime with its own limits for everything. */
function pinnedRuntime(): Service {
  const own: AutoscalingBlock = {
    horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
    verticalAutoscaling: {
      cpuMode: "SHARED",
      startCpuCoreCount: 2,
      swapEnabled: true,
      minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 },
      minResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 1 },
      maxResource: { cpuCoreCount: 8, memoryGBytes: 8, diskGBytes: 250 },
    },
  };
  return {
    id: "svcApp",
    name: "app",
    status: "ACTIVE",
    autoscalingProfileId: null,
    autoscalingProfileOverrides: null,
    customAutoscaling: own,
    currentAutoscaling: resolve(own, RUNTIME_DEFAULTS),
  };
}

/** A runtime that inherits start CPU and swap: `null` in its own block, filled in the current one. */
function inheritingRuntime(): Service {
  const own: AutoscalingBlock = {
    horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
    verticalAutoscaling: {
      cpuMode: "SHARED",
      startCpuCoreCount: null,
      swapEnabled: null,
      minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 },
      minResource: { cpuCoreCount: 1, memoryGBytes: 0.125, diskGBytes: 1 },
      maxResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 2 },
    },
  };
  return {
    id: "svcWeb",
    name: "web",
    status: "ACTIVE",
    autoscalingProfileId: null,
    autoscalingProfileOverrides: null,
    customAutoscaling: own,
    currentAutoscaling: resolve(own, RUNTIME_DEFAULTS),
  };
}

/** A managed single-node database on a profile: no own vertical block, no container range. */
function profileDatabase(): Service {
  return {
    id: "svcDb",
    name: "db",
    status: "ACTIVE",
    autoscalingProfileId: "oltp-hobby",
    autoscalingProfileOverrides: null,
    customAutoscaling: { horizontalAutoscaling: { minContainerCount: null, maxContainerCount: null }, verticalAutoscaling: null },
    currentAutoscaling: {
      horizontalAutoscaling: { minContainerCount: null, maxContainerCount: null },
      verticalAutoscaling: {
        cpuMode: "SHARED",
        startCpuCoreCount: 2,
        swapEnabled: true,
        minFreeResource: { cpuCoreCount: 0.1, cpuCorePercent: 15, memoryGBytes: 0.125, memoryPercent: 15 },
        minResource: { cpuCoreCount: 1, memoryGBytes: 0.25, diskGBytes: 1 },
        maxResource: { cpuCoreCount: 8, memoryGBytes: 48, diskGBytes: 250 },
      },
    },
  };
}

/** Every `null` in the own block filled in from the defaults, as `currentAutoscaling` reports. */
function resolve(own: AutoscalingBlock | null | undefined, defaults: AutoscalingBlock): AutoscalingBlock {
  const fill = (o: unknown, d: unknown): unknown => {
    if (d !== null && typeof d === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) out[k] = fill((o as Record<string, unknown> | null | undefined)?.[k], v);
      return out;
    }
    return o ?? d;
  };
  return fill(own, defaults) as AutoscalingBlock;
}

let server: ReturnType<typeof Bun.serve>;
let services: Service[] = [];
/** `honest` applies the write; `ignores` accepts it and changes nothing; `dropsThresholds`
 *  applies it but loses `minFreeResource`. */
let mode: "honest" | "ignores" | "dropsThresholds" = "honest";
const writes: { method: string; path: string; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace("/api/rest/public", "");
      const body = req.method === "GET" ? undefined : await req.json();
      if (req.method !== "GET") writes.push({ method: req.method, path, body });

      if (req.method === "GET" && path === `/project/${PROJECT_ID}`) {
        return Response.json({ id: PROJECT_ID, name: "shop", status: "ACTIVE", clientId: "c1" });
      }
      const byName = path.match(new RegExp(`^/service-stack-by-name/${PROJECT_ID}/(\\w+)$`));
      const byId = path.match(/^\/service-stack\/(\w+)$/);
      const found = services.find((s) => (byName && s.name === byName[1]) || (byId && s.id === byId[1]));
      if (req.method === "GET" && found) return Response.json(found);

      const scale = path.match(/^\/service-stack\/(\w+)\/autoscaling$/);
      const target = scale && services.find((s) => s.id === scale[1]);
      if (req.method === "PUT" && target) {
        if (mode !== "ignores") {
          const sent = body as { customAutoscaling?: AutoscalingBlock & Record<string, unknown>; autoscalingProfileId?: string | null };
          // Unknown keys are dropped, so the spec's `...Nullable` spelling arrives as an empty block.
          const own: AutoscalingBlock = {
            verticalAutoscaling: sent.customAutoscaling?.verticalAutoscaling ?? null,
            horizontalAutoscaling: sent.customAutoscaling?.horizontalAutoscaling ?? null,
          };
          if (mode === "dropsThresholds" && own.verticalAutoscaling) {
            own.verticalAutoscaling = {
              ...own.verticalAutoscaling,
              minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: null, memoryPercent: null },
            };
          }
          target.customAutoscaling = own;
          target.currentAutoscaling = resolve(own, RUNTIME_DEFAULTS);
          if (sent.autoscalingProfileId !== undefined) target.autoscalingProfileId = sent.autoscalingProfileId;
        }
        // Applied at once (no process), which is all these tests need.
        return Response.json({});
      }
      return Response.json({ error: { code: "notFound", message: `${req.method} ${path}` } }, { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  writes.length = 0;
  mode = "honest";
  services = [pinnedRuntime(), inheritingRuntime(), profileDatabase()];
});

async function zops(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts"), ...args, "-P", PROJECT_ID], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ZEROPS_TOKEN: "fake-token",
      ZEROPS_PROFILE: "",
      ZEROPS_PROJECT: "",
      ZEROPS_SERVICE: "",
      XDG_CONFIG_HOME: "/nonexistent-zops-test-home",
      ZEROPS_API_URL: `http://localhost:${server.port}`,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const scaleGet = async (name: string) => JSON.parse((await zops(["scale", "get", name, "--json"])).stdout);

describe("zops scale set", () => {
  test("--max-cpu and --max-ram on a pinned runtime change those two and keep everything else", async () => {
    const { exitCode, stderr } = await zops(["scale", "set", "app", "--max-cpu", "4", "--max-ram", "4"]);
    expect(stderr).not.toContain("error");
    expect(exitCode).toBe(0);

    expect(writes).toEqual([{
      method: "PUT",
      path: "/service-stack/svcApp/autoscaling",
      body: {
        autoscalingProfileId: null,
        autoscalingProfileOverrides: null,
        customAutoscaling: {
          verticalAutoscaling: {
            cpuMode: "SHARED",
            startCpuCoreCount: 2,
            swapEnabled: true,
            minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 },
            minResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 1 },
            maxResource: { cpuCoreCount: 4, memoryGBytes: 4, diskGBytes: 250 },
          },
          horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
        },
      },
    }]);

    expect(await scaleGet("app")).toEqual({
      service: "app",
      autoscalingProfileId: null,
      minCpu: 1,
      maxCpu: 4,
      minRamGB: 1,
      maxRamGB: 4,
      minDiskGB: 1,
      maxDiskGB: 250,
      minContainers: 1,
      maxContainers: 1,
      cpuMode: "SHARED",
      startCpuCoreCount: 2,
      swapEnabled: true,
    });
  });

  test("the spec's ...Nullable keys are what reset the service, and the body never uses them", async () => {
    // What zops 0.4.1 sent, against the same stand-in: everything drops to the type defaults.
    const res = await fetch(`http://localhost:${server.port}/api/rest/public/service-stack/svcApp/autoscaling`, {
      method: "PUT",
      body: JSON.stringify({
        customAutoscaling: {
          verticalAutoscalingNullable: { maxResource: { cpuCoreCount: 4, memoryGBytes: 4 } },
          horizontalAutoscalingNullable: { minContainerCount: 1, maxContainerCount: 1 },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await scaleGet("app")).toMatchObject({ maxCpu: 8, minRamGB: 0.125, maxRamGB: 48, maxContainers: 10 });

    services = [pinnedRuntime()];
    writes.length = 0;
    await zops(["scale", "set", "app", "--max-cpu", "4"]);
    expect(JSON.stringify(writes[0]!.body)).not.toContain("Nullable");
  });

  test("fails with a field-by-field diff when the service does not report the change", async () => {
    mode = "ignores";
    const { exitCode, stderr } = await zops(["scale", "set", "app", "--max-cpu", "4", "--max-ram", "4", "--timeout", "1s"]);
    expect(exitCode).toBe(8);
    expect(stderr).toContain("maxCpu: wanted 4, service reports 8");
    expect(stderr).toContain("maxRamGB: wanted 4, service reports 8");
    expect(stderr).not.toContain("maxDiskGB");
  });

  test("the diff is in the JSON error too", async () => {
    mode = "ignores";
    const { exitCode, stderr } = await zops(["scale", "set", "app", "--max-cpu", "4", "--timeout", "1s", "--json"]);
    expect(exitCode).toBe(8);
    const error = JSON.parse(stderr.trim().split("\n").at(-1)!);
    expect(JSON.stringify(error)).toContain("autoscalingNotApplied");
    expect(JSON.stringify(error)).toContain(JSON.stringify({ field: "maxCpu", wanted: 4, actual: 8 }));
  });

  test("inherited settings are sent as null, not pinned to the values they resolve to", async () => {
    expect((await zops(["scale", "set", "web", "--max-containers", "3"])).exitCode).toBe(0);
    const body = writes[0]!.body as { customAutoscaling: { verticalAutoscaling: Record<string, unknown>; horizontalAutoscaling: unknown } };
    expect(body.customAutoscaling.verticalAutoscaling.startCpuCoreCount).toBeNull();
    expect(body.customAutoscaling.verticalAutoscaling.swapEnabled).toBeNull();
    expect(body.customAutoscaling.verticalAutoscaling.minFreeResource).toEqual({ cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 });
    expect(body.customAutoscaling.horizontalAutoscaling).toEqual({ minContainerCount: 1, maxContainerCount: 3 });
  });

  test("a database on a profile gets no container block, keeps inherited CPU mode, start CPU, swap and thresholds as null, and keeps its profile", async () => {
    expect((await zops(["scale", "set", "db", "--max-ram", "16"])).exitCode).toBe(0);
    expect(writes[0]!.body).toEqual({
      autoscalingProfileId: "oltp-hobby",
      autoscalingProfileOverrides: null,
      customAutoscaling: {
        verticalAutoscaling: {
          cpuMode: null,
          startCpuCoreCount: null,
          swapEnabled: null,
          minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: null, memoryPercent: null },
          minResource: { cpuCoreCount: 1, memoryGBytes: 0.25, diskGBytes: 1 },
          maxResource: { cpuCoreCount: 8, memoryGBytes: 16, diskGBytes: 250 },
        },
      },
    });
  });

  test("--dry-run prints the complete body and the changes, and sends nothing", async () => {
    const { stdout, exitCode } = await zops(["scale", "set", "app", "--max-cpu", "4", "--dry-run", "--json"]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ dryRun: true, operation: "ConfigureAutoscaling", service: "app", changed: ["max-cpu"], changes: ["maxCpu 8 → 4"] });
    expect(out.body.customAutoscaling.verticalAutoscaling.maxResource).toEqual({ cpuCoreCount: 4, memoryGBytes: 8, diskGBytes: 250 });
    expect(out.body.customAutoscaling.horizontalAutoscaling).toEqual({ minContainerCount: 1, maxContainerCount: 1 });
    expect(writes).toEqual([]);
  });

  test("a minimum above the maximum after the merge is refused before anything is sent", async () => {
    const { exitCode, stderr } = await zops(["scale", "set", "app", "--min-cpu", "10"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("minCpu 10 is above maxCpu 8");
    expect(writes).toEqual([]);
  });

  test("container counts on a managed database are refused before anything is sent", async () => {
    for (const flags of [["--max-containers", "3"], ["--min-containers", "1"], ["--max-ram", "16", "--max-containers", "3"]]) {
      const { exitCode, stderr } = await zops(["scale", "set", "db", ...flags]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("no container range");
    }
    expect((await zops(["scale", "set", "db", "--max-containers", "3", "--dry-run", "--json"])).exitCode).toBe(2);
    expect(writes).toEqual([]);
  });

  test("a write that loses the service's own thresholds fails the read-back", async () => {
    mode = "dropsThresholds";
    const { exitCode, stderr } = await zops(["scale", "set", "app", "--max-cpu", "4", "--timeout", "1s"]);
    expect(exitCode).toBe(8);
    expect(stderr).toContain("minFreeResource.memoryGBytes: wanted 0.25, service reports -");
    expect(stderr).toContain("minFreeResource.memoryPercent: wanted 25, service reports -");
    // Inherited thresholds were sent as null, so they are not checked.
    expect(stderr).not.toContain("minFreeResource.cpuCoreCount");
  });

  test("a profile switch lists the own limits that keep overriding the new profile", async () => {
    const { stdout, exitCode } = await zops(["scale", "set", "app", "--autoscaling-profile", "some-profile", "--max-cpu", "4", "--dry-run", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).changes).toEqual([
      "maxCpu 8 → 4",
      "autoscalingProfileId - → some-profile",
      "kept as the service's own, over the profile: minCpu 1, minRamGB 1, maxRamGB 8, minDiskGB 1, maxDiskGB 250, minContainers 1, maxContainers 1",
    ]);
  });

  test("nothing to change is a usage error", async () => {
    expect((await zops(["scale", "set", "app"])).exitCode).toBe(2);
    expect(writes).toEqual([]);
  });
});

describe("autoscalingBody", () => {
  test("a profile change does not pin the old profile's resolved limits", () => {
    const body = autoscalingBody(profileDatabase(), { autoscalingProfileId: "oltp-production" });
    expect(body.autoscalingProfileId).toBe("oltp-production");
    expect(body.customAutoscaling.verticalAutoscaling.minResource).toEqual({ cpuCoreCount: null, memoryGBytes: null, diskGBytes: null });
    expect(body.customAutoscaling.verticalAutoscaling.maxResource).toEqual({ cpuCoreCount: null, memoryGBytes: null, diskGBytes: null });
  });

  test("a profile change keeps the service's own limits and takes passed ones", () => {
    const body = autoscalingBody(pinnedRuntime(), { autoscalingProfileId: "some-profile", maxCpu: 4 });
    expect(body.customAutoscaling.verticalAutoscaling.maxResource).toEqual({ cpuCoreCount: 4, memoryGBytes: 8, diskGBytes: 250 });
  });

  test("no profile key is invented when the service DTO has none", () => {
    const service = pinnedRuntime();
    delete service.autoscalingProfileId;
    delete service.autoscalingProfileOverrides;
    const body = autoscalingBody(service, { maxCpu: 4 });
    expect("autoscalingProfileId" in body).toBe(false);
    expect("autoscalingProfileOverrides" in body).toBe(false);
  });
});
