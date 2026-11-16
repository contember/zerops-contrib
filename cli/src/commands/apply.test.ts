/**
 * The emitter is the one place `zops apply` can silently corrupt an import: it
 * rebuilds a partial document for the services that are missing, and whatever
 * it gets wrong the platform accepts as fact. So every case here re-parses its
 * own output, and the preprocessor cases assert the expression survives the
 * round trip untouched — the platform expands it after this, not before.
 */
import { expect, test } from "bun:test";
import { emitYaml, scalingPlan, servicesDocument } from "./apply.ts";

test("round-trips scalars, nesting and lists", () => {
  const value = {
    hostname: "pim",
    type: "bun@1.3.9",
    enableSubdomainAccess: true,
    minContainers: 1,
    verticalAutoscaling: { cpuMode: "SHARED", maxCpu: 4 },
    tags: ["a", "b"],
  };
  expect(Bun.YAML.parse(emitYaml(value))).toEqual(value);
});

test("keeps preprocessor expressions verbatim", () => {
  const document = servicesDocument(
    [
      {
        hostname: "pim",
        type: "bun@1.3.9",
        envSecrets: { PIM_SESSION_SECRET: "<@generateRandomString(<64>)>" },
      },
    ],
    true,
  );
  expect(document.startsWith("#yamlPreprocessor=on\n")).toBe(true);

  const parsed = Bun.YAML.parse(document) as {
    services: { envSecrets: Record<string, string> }[];
  };
  expect(parsed.services[0]!.envSecrets.PIM_SESSION_SECRET).toBe(
    "<@generateRandomString(<64>)>",
  );
});

test("emits several services as a list", () => {
  const document = servicesDocument(
    [
      { hostname: "pimdb", type: "postgresql:single@18", profile: "oltp-hobby" },
      { hostname: "pimblobs", type: "object-storage", objectStorageSize: 5 },
    ],
    false,
  );
  expect(Bun.YAML.parse(document)).toEqual({
    services: [
      { hostname: "pimdb", type: "postgresql:single@18", profile: "oltp-hobby" },
      { hostname: "pimblobs", type: "object-storage", objectStorageSize: 5 },
    ],
  });
});

test("survives values that would break a naive quoter", () => {
  const value = {
    // Backslashes, quotes and a reference the second pass must still see.
    url: 'postgresql://u:p@h:5432/d?x="1"\\y',
    reference: "${db_connectionString}",
  };
  expect(Bun.YAML.parse(emitYaml(value))).toEqual(value);
});

test("emits a multi-line value as a block scalar", () => {
  const value = { key: "line one\nline two\n" };
  const emitted = emitYaml(value);
  expect(emitted).toContain("|");
  expect(Bun.YAML.parse(emitted)).toEqual({ key: "line one\nline two\n" });
});

/* Scaling goes through the same body builder as `zops scale set`; these pin that `apply` sends
   the keys the server reads and keeps what the declaration does not mention. */
const runtime = {
  autoscalingProfileId: null,
  autoscalingProfileOverrides: null,
  customAutoscaling: {
    horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
    verticalAutoscaling: {
      cpuMode: "SHARED",
      startCpuCoreCount: 2,
      swapEnabled: true,
      minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 },
      minResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 1 },
      maxResource: { cpuCoreCount: 8, memoryGBytes: 8, diskGBytes: 250 },
    },
  },
  currentAutoscaling: {
    horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
    verticalAutoscaling: {
      cpuMode: "SHARED",
      startCpuCoreCount: 2,
      swapEnabled: true,
      minFreeResource: { cpuCoreCount: 0.1, cpuCorePercent: 0, memoryGBytes: 0.25, memoryPercent: 25 },
      minResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 1 },
      maxResource: { cpuCoreCount: 8, memoryGBytes: 8, diskGBytes: 250 },
    },
  },
};

test("declared scaling merges into the current configuration under the keys the server reads", () => {
  const plan = scalingPlan({ hostname: "app", verticalAutoscaling: { maxCpu: 4, maxRam: 4 } }, runtime);
  expect(plan?.changes).toEqual(["maxCpu 8 → 4", "maxRamGB 8 → 4"]);
  expect(JSON.stringify(plan?.body)).not.toContain("Nullable");
  expect(plan?.body.customAutoscaling).toEqual({
    verticalAutoscaling: {
      cpuMode: "SHARED",
      startCpuCoreCount: 2,
      swapEnabled: true,
      minFreeResource: { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: 0.25, memoryPercent: 25 },
      minResource: { cpuCoreCount: 1, memoryGBytes: 1, diskGBytes: 1 },
      maxResource: { cpuCoreCount: 4, memoryGBytes: 4, diskGBytes: 250 },
    },
    horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 1 },
  });
});

/** A managed database on a profile: no own vertical block, no container range. */
const database = {
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

test("declared container counts on a managed database are neither planned nor sent", () => {
  // Otherwise every run would plan `minContainers - → 1` again and fail its read-back.
  expect(scalingPlan({ hostname: "db", minContainers: 1, maxContainers: 1 }, database)).toBeNull();

  const plan = scalingPlan({ hostname: "db", minContainers: 1, maxContainers: 1, verticalAutoscaling: { maxRam: 16 } }, database);
  expect(plan?.changes).toEqual(["maxRamGB 48 → 16"]);
  expect(plan?.body.customAutoscaling.horizontalAutoscaling).toBeUndefined();
});

test("declared scaling that already holds plans nothing", () => {
  expect(scalingPlan({ hostname: "app", minContainers: 1, verticalAutoscaling: { maxCpu: 8 } }, runtime)).toBeNull();
  expect(scalingPlan({ hostname: "app" }, runtime)).toBeNull();
});
