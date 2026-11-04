import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sensitiveForUpdate } from "./env.ts";

/**
 * `zops env set` and `zops project env …` against a stand-in API that records every write, so a
 * test can see exactly which body an update sent. The real API treats `sensitive` on an update as
 * a full overwrite: leaving it out turns a secret into a plain, readable variable.
 */
const PROJECT_ID = "Pr0jectIdForEnvTests01";

interface Var {
  id: string;
  key: string;
  content: string;
  sensitive: boolean;
  type?: string;
  editable?: boolean;
}

let server: ReturnType<typeof Bun.serve>;
let userData: Var[] = [];
let projectEnv: Var[] = [];
const writes: { method: string; path: string; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace("/api/rest/public", "");
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json();
      if (req.method !== "GET") writes.push({ method: req.method, path, body });

      if (req.method === "GET" && path === `/project/${PROJECT_ID}`) {
        return Response.json({ id: PROJECT_ID, name: "shop", status: "ACTIVE", clientId: "c1" });
      }
      if (req.method === "GET" && path === `/service-stack-by-name/${PROJECT_ID}/app`) {
        return Response.json({ id: "svcApp", name: "app", status: "ACTIVE" });
      }
      if (req.method === "GET" && path === "/service-stack/svcApp/user-data") {
        return Response.json({ items: userData.map((v) => ({ ...v, serviceStackId: "svcApp" })) });
      }
      if (req.method === "GET" && path === `/project/${PROJECT_ID}/env`) {
        return Response.json({ items: projectEnv });
      }
      // Writes are applied immediately (no process), which is all these tests need.
      if (req.method !== "GET") return Response.json({});
      return Response.json({ error: { code: "notFound", message: `${req.method} ${path}` } }, { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  writes.length = 0;
  userData = [
    { id: "udSecret", key: "API_KEY", content: "REDACTED", sensitive: true },
    { id: "udPlain", key: "LOG_LEVEL", content: "info", sensitive: false },
  ];
  projectEnv = [
    { id: "peSecret", key: "TOKEN", content: "REDACTED", sensitive: true, type: "USER" },
    { id: "pePlain", key: "MODE", content: "production", sensitive: false, type: "USER" },
    { id: "peIsolation", key: "envIsolation", content: "'service'", sensitive: false, type: "SYSTEM", editable: true },
    { id: "peHost", key: "zeropsSubdomainHost", content: "'2932'", sensitive: false, type: "SYSTEM", editable: false },
  ];
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

describe("sensitiveForUpdate", () => {
  test("keeps the current setting unless a flag says otherwise", () => {
    expect(sensitiveForUpdate(undefined, true)).toBe(true);
    expect(sensitiveForUpdate(undefined, false)).toBe(false);
    expect(sensitiveForUpdate(undefined, undefined)).toBe(false);
    expect(sensitiveForUpdate(true, false)).toBe(true);
    expect(sensitiveForUpdate(false, true)).toBe(false);
  });
});

describe("zops env set", () => {
  test("updating a sensitive variable without a flag keeps it sensitive", async () => {
    const { exitCode } = await zops(["env", "set", "API_KEY", "new-value", "app"]);
    expect(exitCode).toBe(0);
    expect(writes).toEqual([{ method: "PUT", path: "/user-data/udSecret", body: { key: "API_KEY", content: "new-value", sensitive: true } }]);
  });

  test("--sensitive on an existing plain variable makes it sensitive", async () => {
    await zops(["env", "set", "LOG_LEVEL", "debug", "app", "--sensitive"]);
    expect(writes).toEqual([{ method: "PUT", path: "/user-data/udPlain", body: { key: "LOG_LEVEL", content: "debug", sensitive: true } }]);
  });

  test("--no-sensitive is the explicit way to make a secret plain", async () => {
    await zops(["env", "set", "API_KEY", "now-public", "app", "--no-sensitive"]);
    expect(writes).toEqual([{ method: "PUT", path: "/user-data/udSecret", body: { key: "API_KEY", content: "now-public", sensitive: false } }]);
  });

  test("a new variable is plain unless --sensitive", async () => {
    await zops(["env", "set", "NEW_PLAIN", "a", "app"]);
    await zops(["env", "set", "NEW_SECRET", "b", "app", "--sensitive"]);
    expect(writes).toEqual([
      { method: "POST", path: "/service-stack/svcApp/user-data", body: { key: "NEW_PLAIN", content: "a", sensitive: false } },
      { method: "POST", path: "/service-stack/svcApp/user-data", body: { key: "NEW_SECRET", content: "b", sensitive: true } },
    ]);
  });

  test("a key that differs only in case is refused, not created as a plain twin of a secret", async () => {
    const { exitCode, stderr } = await zops(["env", "set", "api_key", "v", "app"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("already has 'API_KEY'");
    expect(writes).toEqual([]);
  });

  test("--dry-run reports the sensitivity the update would send", async () => {
    const { stdout } = await zops(["env", "set", "API_KEY", "x", "app", "--dry-run", "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, operation: "UpdateUserDataById", sensitive: true });
    expect(writes).toEqual([]);
  });
});

describe("zops project env", () => {
  test("list shows the project's variables and the platform settings a user may change", async () => {
    const { stdout, exitCode } = await zops(["project", "env", "list", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).map((v: Var) => v.key)).toEqual(["TOKEN", "MODE", "envIsolation"]);
  });

  test("set updates an editable platform setting in place and refuses a fixed one", async () => {
    expect((await zops(["project", "env", "set", "envIsolation", "none"])).exitCode).toBe(0);
    const fixed = await zops(["project", "env", "set", "zeropsSubdomainHost", "x"]);
    expect(fixed.exitCode).toBe(2);
    expect(fixed.stderr).toContain("set by the platform");
    expect(writes).toEqual([{ method: "PUT", path: "/project-env/peIsolation", body: { key: "envIsolation", content: "none", sensitive: false } }]);
  });

  test("set updates an existing variable with its key and keeps it sensitive", async () => {
    const { exitCode } = await zops(["project", "env", "set", "TOKEN", "rotated"]);
    expect(exitCode).toBe(0);
    expect(writes).toEqual([{ method: "PUT", path: "/project-env/peSecret", body: { key: "TOKEN", content: "rotated", sensitive: true } }]);
  });

  test("set creates a variable that does not exist yet", async () => {
    await zops(["project", "env", "set", "NEW_ONE", "v", "--sensitive"]);
    expect(writes).toEqual([{ method: "POST", path: `/project/${PROJECT_ID}/env`, body: { key: "NEW_ONE", content: "v", sensitive: true } }]);
  });

  test("unset finds the variable and deletes it", async () => {
    const { exitCode } = await zops(["project", "env", "unset", "MODE", "--yes"]);
    expect(exitCode).toBe(0);
    expect(writes).toEqual([{ method: "DELETE", path: "/project-env/pePlain", body: undefined }]);
  });

  test("unset of a missing variable is not found, and a platform variable is refused", async () => {
    expect((await zops(["project", "env", "unset", "NOPE", "--yes"])).exitCode).toBe(4);
    expect((await zops(["project", "env", "unset", "envIsolation", "--yes"])).exitCode).toBe(2);
    expect((await zops(["project", "env", "unset", "token", "--yes"])).exitCode).toBe(2);
    expect(writes).toEqual([]);
  });
});
