/**
 * Builds the deployment artifact.
 *
 * The API wants a gzipped tar streamed to a presigned URL. Writing the tar directly avoids a
 * dependency and, more importantly, avoids shelling out to a `tar` whose flags differ between
 * GNU and BSD. The archive is staged in a temp file and then streamed through gzip, so memory
 * stays flat regardless of repository size.
 */
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { usage, ZzError, EXIT } from "./errors.ts";
import type { Output } from "./output.ts";

const BLOCK = 512;

interface Entry {
  sourcePath: string;
  archivePath: string;
}

export type WorkspaceState = "all" | "clean";

export interface PackOptions {
  workingDir: string;
  /** Ignore git entirely and archive the directory as it sits on disk. */
  noGit: boolean;
  /** `all` = working tree (tracked + untracked, minus ignored); `clean` = exactly HEAD. */
  workspaceState: WorkspaceState;
  /** Include the `.git` directory in the artifact. */
  includeGitFolder: boolean;
  /**
   * Explicit files/directories to archive, relative to `workingDir`. Set by `zz deploy` to ship
   * prebuilt artifacts; when present, git and directory discovery are bypassed entirely.
   */
  include?: string[];
  out: Output;
}

export interface PackResult {
  /** Path to the staged, uncompressed tar. Caller must call `cleanup()`. */
  tarPath: string;
  fileCount: number;
  byteSize: number;
  cleanup: () => Promise<void>;
}

// --- tar writing ---------------------------------------------------------

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(buf: Uint8Array, text: string, offset: number, length: number): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > length) throw new Error(`field overflow at offset ${offset}`);
  buf.set(bytes, offset);
}

interface HeaderFields {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: "0" | "5" | "2" | "L";
  linkname?: string;
  prefix?: string;
}

function tarHeader(f: HeaderFields): Uint8Array {
  const buf = new Uint8Array(BLOCK);
  writeString(buf, f.name, 0, 100);
  writeString(buf, octal(f.mode & 0o7777, 8), 100, 8);
  writeString(buf, octal(0, 8), 108, 8); // uid — normalised, the build container owns the files
  writeString(buf, octal(0, 8), 116, 8); // gid
  writeString(buf, octal(f.size, 12), 124, 12);
  writeString(buf, octal(f.mtime, 12), 136, 12);
  buf.fill(0x20, 148, 156); // checksum field is spaces while the checksum is computed
  writeString(buf, f.typeflag, 156, 1);
  if (f.linkname) writeString(buf, f.linkname, 157, 100);
  writeString(buf, "ustar\0", 257, 6);
  writeString(buf, "00", 263, 2);
  if (f.prefix) writeString(buf, f.prefix, 345, 155);

  let sum = 0;
  for (const byte of buf) sum += byte;
  writeString(buf, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

function padding(size: number): Uint8Array {
  const remainder = size % BLOCK;
  return remainder === 0 ? new Uint8Array(0) : new Uint8Array(BLOCK - remainder);
}

/**
 * ustar caps names at 100 bytes, extended to 255 by splitting on a `/` into prefix+name.
 * Longer paths (deep `node_modules` trees routinely exceed 255) get a GNU long-name record,
 * which the Go tar reader on the receiving end understands.
 */
function nameFields(path: string): { name: string; prefix?: string; needsLongName: boolean } {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length <= 100) return { name: path, needsLongName: false };

  if (bytes.length <= 255) {
    for (let i = path.length - 101; i >= 0; i--) {
      if (path[i] !== "/") continue;
      const prefix = path.slice(0, i);
      const name = path.slice(i + 1);
      if (
        new TextEncoder().encode(prefix).length <= 155 &&
        new TextEncoder().encode(name).length <= 100
      ) {
        return { name, prefix, needsLongName: false };
      }
    }
  }
  return { name: path.slice(0, 100), needsLongName: true };
}

class TarWriter {
  private bytesWritten = 0;

  constructor(private readonly sink: import("bun").FileSink) {}

  private write(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.sink.write(chunk);
    this.bytesWritten += chunk.length;
  }

  private async writeHeader(fields: HeaderFields, path: string): Promise<void> {
    const { name, prefix, needsLongName } = nameFields(path);
    if (needsLongName) {
      const raw = new TextEncoder().encode(`${path}\0`);
      this.write(tarHeader({ name: "././@LongLink", mode: 0o644, size: raw.length, mtime: 0, typeflag: "L" }));
      this.write(raw);
      this.write(padding(raw.length));
    }
    this.write(tarHeader({ ...fields, name, prefix }));
  }

  async addFile(entry: Entry): Promise<void> {
    const info = await lstat(entry.sourcePath);

    if (info.isSymbolicLink()) {
      const target = await readlink(entry.sourcePath);
      await this.writeHeader(
        {
          name: entry.archivePath,
          mode: 0o777,
          size: 0,
          mtime: Math.floor(info.mtimeMs / 1000),
          typeflag: "2",
          linkname: target,
        },
        entry.archivePath,
      );
      return;
    }

    if (info.isDirectory()) {
      const path = entry.archivePath.endsWith("/") ? entry.archivePath : `${entry.archivePath}/`;
      await this.writeHeader(
        { name: path, mode: info.mode, size: 0, mtime: Math.floor(info.mtimeMs / 1000), typeflag: "5" },
        path,
      );
      return;
    }

    if (!info.isFile()) {
      throw new ZzError({
        code: "unsupportedFileType",
        message: `cannot archive ${entry.archivePath}: not a regular file, directory or symlink`,
        exitCode: EXIT.ERROR,
      });
    }

    await this.writeHeader(
      {
        name: entry.archivePath,
        mode: info.mode,
        size: info.size,
        mtime: Math.floor(info.mtimeMs / 1000),
        typeflag: "0",
      },
      entry.archivePath,
    );

    // Small files go through readFile; large ones stream so a big asset cannot blow up memory.
    if (info.size <= 8 * 1024 * 1024) {
      this.write(new Uint8Array(await readFile(entry.sourcePath)));
    } else {
      for await (const chunk of createReadStream(entry.sourcePath)) {
        this.write(new Uint8Array(chunk as Buffer));
      }
    }
    this.write(padding(info.size));
  }

  finish(): number {
    this.write(new Uint8Array(BLOCK * 2)); // two zero blocks terminate the archive
    return this.bytesWritten;
  }
}

// --- ignore rules --------------------------------------------------------

/** Minimal gitignore-style matcher covering the subset `.deployignore` files actually use. */
export class Ignorer {
  private readonly rules: { negate: boolean; re: RegExp; dirOnly: boolean }[] = [];

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const negate = line.startsWith("!");
      const body = negate ? line.slice(1) : line;
      const dirOnly = body.endsWith("/");
      const pattern = dirOnly ? body.slice(0, -1) : body;
      this.rules.push({ negate, dirOnly, re: this.compile(pattern) });
    }
  }

  private compile(pattern: string): RegExp {
    const anchored = pattern.startsWith("/");
    const body = anchored ? pattern.slice(1) : pattern;
    let re = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === "*") {
        if (body[i + 1] === "*") {
          re += ".*";
          i++;
          if (body[i + 1] === "/") i++;
        } else {
          re += "[^/]*";
        }
      } else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    // An unanchored pattern matches at any depth, exactly like gitignore.
    return new RegExp(anchored ? `^${re}(/.*)?$` : `(^|.*/)${re}(/.*)?$`);
  }

  ignores(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(path)) ignored = !rule.negate;
    }
    return ignored;
  }
}

async function loadIgnorer(workingDir: string): Promise<Ignorer | null> {
  try {
    const text = await readFile(join(workingDir, ".deployignore"), "utf8");
    return new Ignorer(text.split("\n"));
  } catch {
    return null;
  }
}

// --- file discovery ------------------------------------------------------

async function git(workingDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: workingDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

async function isGitRepo(workingDir: string): Promise<boolean> {
  try {
    return (await git(workingDir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

async function walkDir(root: string, ignorer: Ignorer | null): Promise<string[]> {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/")) continue;
      const isDir = entry.isDirectory() && !entry.isSymbolicLink();
      if (ignorer?.ignores(rel, isDir)) continue;
      if (isDir) stack.push(abs);
      else found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Stages the artifact and returns the path to the uncompressed tar.
 *
 * `clean` delegates to `git archive HEAD`, which is the only way to get exactly the committed
 * tree without touching the working directory. Everything else is packed from disk.
 */
export async function packArtifact(options: PackOptions): Promise<PackResult> {
  const { workingDir, out } = options;
  const dir = await mkdtemp(join(tmpdir(), "zz-pack-"));
  const tarPath = join(dir, "artifact.tar");
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const explicit = options.include ?? [];
  const useGit = explicit.length === 0 && !options.noGit && (await isGitRepo(workingDir));
  if (explicit.length === 0 && !useGit && options.workspaceState === "clean") {
    await cleanup();
    throw usage(
      "--workspace-state clean requires a git repository",
      "Drop the flag to archive the working directory as-is.",
    );
  }

  try {
    if (useGit && options.workspaceState === "clean") {
      // `git archive` emits a finished tar; stage it verbatim.
      const proc = Bun.spawn(["git", "archive", "--format=tar", "HEAD"], {
        cwd: workingDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain the pipe into a sink rather than handing the stream to Bun.write, which does not
      // consume ReadableStreams, and keep memory flat for large repositories.
      const sink = Bun.file(tarPath).writer();
      let written = 0;
      for await (const chunk of proc.stdout) {
        sink.write(chunk);
        written += chunk.length;
      }
      await sink.end();
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`git archive HEAD failed: ${(await new Response(proc.stderr).text()).trim()}`);
      }
      const count = (await git(workingDir, ["ls-tree", "-r", "--name-only", "HEAD"]))
        .split("\n")
        .filter(Boolean).length;
      out.debug(`packed ${count} files from HEAD (${written} bytes uncompressed)`);
      return { tarPath, fileCount: count, byteSize: written, cleanup };
    }

    const ignorer = await loadIgnorer(workingDir);
    let paths: string[];
    if (explicit.length > 0) {
      // `zz deploy ./dist ./package.json`: each entry is taken verbatim, expanding directories.
      // Paths keep their names relative to workingDir so the artifact mirrors the repo layout.
      const collected: string[] = [];
      for (const entry of explicit) {
        const rel = entry.replace(/^\.\//, "").replace(/\/+$/, "");
        const abs = join(workingDir, rel);
        const info = await stat(abs).catch(() => null);
        if (!info) {
          throw usage(`cannot deploy '${entry}': no such file or directory in ${workingDir}`);
        }
        if (info.isDirectory()) {
          const nested = await walkDir(abs, ignorer);
          collected.push(...nested.map((p) => (rel === "." ? p : `${rel}/${p}`)));
        } else if (!ignorer?.ignores(rel, false)) {
          collected.push(rel);
        }
      }
      paths = [...new Set(collected)].sort();
    } else if (useGit) {
      // Tracked plus untracked-but-not-ignored: what the developer actually has, minus junk.
      const listed = await git(workingDir, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]);
      paths = listed.split("\0").filter(Boolean);
      if (ignorer) paths = paths.filter((p) => !ignorer.ignores(p, false));
      // git lists index entries that may have been deleted on disk since.
      const existing = await Promise.all(
        paths.map(async (p) => ((await stat(join(workingDir, p)).catch(() => null)) ? p : null)),
      );
      paths = existing.filter((p): p is string => p !== null).sort();
    } else {
      paths = await walkDir(workingDir, ignorer);
    }

    if (options.includeGitFolder && useGit) {
      paths = [...paths, ...(await walkDir(join(workingDir, ".git"), null)).map((p) => `.git/${p}`)];
    }

    if (paths.length === 0) {
      throw usage(
        `nothing to deploy from ${workingDir}`,
        explicit.length > 0
          ? "The given paths matched no files."
          : "Every file was excluded — check .deployignore and .gitignore.",
      );
    }

    const sink = Bun.file(tarPath).writer();
    const writer = new TarWriter(sink);
    for (const path of paths) {
      await writer.addFile({ sourcePath: join(workingDir, path), archivePath: path });
    }
    const byteSize = writer.finish();
    await sink.end();

    out.debug(`packed ${paths.length} files (${byteSize} bytes uncompressed)`);
    return { tarPath, fileCount: paths.length, byteSize, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Whatever CompressionStream accepts on its writable side (BufferSource, in practice). */
type CompressionInput =
  CompressionStream extends { writable: WritableStream<infer T> } ? T : never;

/** Streams the staged tar through gzip; the result is fed straight into the upload request. */
export function gzipStream(tarPath: string): ReadableStream<Uint8Array> {
  // Stream generics are invariant, so the source is typed to exactly what the compressor
  // accepts rather than to the narrower Uint8Array the file stream actually produces.
  const source: ReadableStream<CompressionInput> = Readable.toWeb(createReadStream(tarPath));
  return source.pipeThrough(new CompressionStream("gzip"));
}
