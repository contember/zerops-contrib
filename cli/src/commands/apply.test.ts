/**
 * The emitter is the one place `zops apply` can silently corrupt an import: it
 * rebuilds a partial document for the services that are missing, and whatever
 * it gets wrong the platform accepts as fact. So every case here re-parses its
 * own output, and the preprocessor cases assert the expression survives the
 * round trip untouched — the platform expands it after this, not before.
 */
import { expect, test } from "bun:test";
import { emitYaml, servicesDocument } from "./apply.ts";

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
