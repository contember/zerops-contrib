import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packArtifact, gzipStream, Ignorer, ancestorDirectories } from "./archive.ts";
import { Output } from "./output.ts";

const out = new Output({ quiet: true });

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zops-test-"));
}

/** Reads the produced archive back with the system tar, i.e. a real third-party parser. */
async function listWithSystemTar(tarPath: string): Promise<string[]> {
  const gz = `${tarPath}.gz`;
  await Bun.write(gz, await new Response(gzipStream(tarPath)).arrayBuffer());
  const proc = Bun.spawn(["tar", "-tzf", gz], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return stdout.split("\n").filter(Boolean).sort();
}

describe("packArtifact", () => {
  test("packs a plain directory that system tar can read back", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "index.js"), "console.log(1)\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const a = 1\n");

    const result = await packArtifact({
      workingDir: dir,
      noGit: true,
      workspaceState: "all",
      includeGitFolder: false,
      out,
    });

    expect(result.fileCount).toBe(2);
    // The directory entry is required: the platform's unpacker does not create
    // parents, and an archive without it dies during unpack with no build log.
    expect(await listWithSystemTar(result.tarPath)).toEqual(["index.js", "src/", "src/app.ts"]);

    const extractDir = await scratch();
    const proc = Bun.spawn(["tar", "-xzf", `${result.tarPath}.gz`, "-C", extractDir]);
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(join(extractDir, "src/app.ts")).text()).toBe("export const a = 1\n");

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
    await rm(extractDir, { recursive: true, force: true });
  });

  test("preserves symlinks and executable bits", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await symlink("run.sh", join(dir, "link.sh"));

    const result = await packArtifact({
      workingDir: dir,
      noGit: true,
      workspaceState: "all",
      includeGitFolder: false,
      out,
    });

    await Bun.write(
      `${result.tarPath}.gz`,
      await new Response(gzipStream(result.tarPath)).arrayBuffer(),
    );
    const proc = Bun.spawn(["tar", "-tvzf", `${result.tarPath}.gz`], { stdout: "pipe" });
    const listing = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(listing).toContain("rwxr-xr-x");
    expect(listing).toMatch(/link\.sh -> run\.sh/);

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  test("handles paths longer than the 100-byte ustar name field", async () => {
    const dir = await scratch();
    // 255 bytes total forces the prefix split; beyond that forces a GNU long-name record.
    const deep = join("node_modules", "@scope", "a".repeat(80), "lib", "b".repeat(80), "nested");
    const veryDeep = join(deep, "c".repeat(90), "index.js");
    await mkdir(join(dir, veryDeep, ".."), { recursive: true });
    await writeFile(join(dir, veryDeep), "module.exports = 1\n");

    const result = await packArtifact({
      workingDir: dir,
      noGit: true,
      workspaceState: "all",
      includeGitFolder: false,
      out,
    });

    const listed = await listWithSystemTar(result.tarPath);
    const file = veryDeep.split("\\").join("/");
    expect(listed).toContain(file);
    // Long paths take the GNU long-name route for directories too.
    expect(listed).toContain(`${deep.split("\\").join("/")}/`);
    expect(listed.filter((entry) => !entry.endsWith("/"))).toEqual([file]);

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  test("applies .deployignore", async () => {
    const dir = await scratch();
    await writeFile(join(dir, ".deployignore"), "*.log\nsecrets/\n!keep.log\n");
    await writeFile(join(dir, "app.js"), "1\n");
    await writeFile(join(dir, "debug.log"), "noise\n");
    await writeFile(join(dir, "keep.log"), "wanted\n");
    await mkdir(join(dir, "secrets"), { recursive: true });
    await writeFile(join(dir, "secrets", "token"), "shh\n");

    const result = await packArtifact({
      workingDir: dir,
      noGit: true,
      workspaceState: "all",
      includeGitFolder: false,
      out,
    });

    const listed = await listWithSystemTar(result.tarPath);
    expect(listed).toContain("app.js");
    expect(listed).toContain("keep.log");
    expect(listed).not.toContain("debug.log");
    expect(listed.some((p) => p.startsWith("secrets/"))).toBe(false);

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  test("git mode includes untracked-but-not-ignored files and skips ignored ones", async () => {
    const dir = await scratch();
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
      expect(await proc.exited).toBe(0);
    };
    await run("init", "-q");
    await run("config", "user.email", "t@example.com");
    await run("config", "user.name", "t");
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(dir, "committed.js"), "1\n");
    await run("add", ".");
    await run("commit", "-qm", "init");
    await writeFile(join(dir, "untracked.js"), "2\n");
    await writeFile(join(dir, "ignored.txt"), "3\n");

    const all = await packArtifact({
      workingDir: dir,
      noGit: false,
      workspaceState: "all",
      includeGitFolder: false,
      out,
    });
    const allFiles = await listWithSystemTar(all.tarPath);
    expect(allFiles).toContain("committed.js");
    expect(allFiles).toContain("untracked.js");
    expect(allFiles).not.toContain("ignored.txt");
    expect(allFiles.some((p) => p.startsWith(".git/"))).toBe(false);
    await all.cleanup();

    // `clean` must reflect HEAD only, so the untracked file disappears.
    const clean = await packArtifact({
      workingDir: dir,
      noGit: false,
      workspaceState: "clean",
      includeGitFolder: false,
      out,
    });
    const cleanFiles = await listWithSystemTar(clean.tarPath);
    expect(cleanFiles).toContain("committed.js");
    expect(cleanFiles).not.toContain("untracked.js");
    await clean.cleanup();

    await rm(dir, { recursive: true, force: true });
  });
});

describe("Ignorer", () => {
  test("matches gitignore-style patterns at any depth", () => {
    const ig = new Ignorer(["*.log", "/root-only.txt", "build/", "**/tmp"]);
    expect(ig.ignores("a.log", false)).toBe(true);
    expect(ig.ignores("deep/nested/a.log", false)).toBe(true);
    expect(ig.ignores("root-only.txt", false)).toBe(true);
    expect(ig.ignores("sub/root-only.txt", false)).toBe(false);
    expect(ig.ignores("build", true)).toBe(true);
    expect(ig.ignores("build", false)).toBe(false);
    expect(ig.ignores("src/tmp", true)).toBe(true);
    expect(ig.ignores("src/index.ts", false)).toBe(false);
  });

  test("later negation wins", () => {
    const ig = new Ignorer(["*.log", "!keep.log"]);
    expect(ig.ignores("a.log", false)).toBe(true);
    expect(ig.ignores("keep.log", false)).toBe(false);
  });
});

describe("ancestorDirectories", () => {
  test("lists every parent, parents before children", () => {
    expect(ancestorDirectories(["a/b/c.txt", "a/d.txt", "top.txt"])).toEqual([
      "a",
      "a/b",
    ]);
  });

  test("emits an enclosing directory ahead of anything inside it", () => {
    const ordered = ancestorDirectories([
      "z/y/x/deep.txt",
      "a/file.txt",
      "z/other.txt",
    ]);
    for (const [index, directory] of ordered.entries()) {
      const parent = directory.slice(0, directory.lastIndexOf("/"));
      if (parent === "" || !ordered.includes(parent)) continue;
      expect(ordered.indexOf(parent)).toBeLessThan(index);
    }
  });

  test("has nothing to add for a flat listing", () => {
    expect(ancestorDirectories(["a.txt", "b.txt"])).toEqual([]);
  });
});
