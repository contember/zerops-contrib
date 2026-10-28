/**
 * `zops push` and `zops deploy`.
 *
 * Both follow the same four-step platform flow: create an app version, stream a gzipped tar to
 * the presigned URL it hands back, trigger the pipeline, then wait. `push` builds on the
 * platform; `deploy` ships artifacts you already built.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CommandSpec } from "../lib/spec.ts";
import type { Context, ServiceSummary } from "../lib/context.ts";
import { gzipStream, packArtifact, type WorkspaceState } from "../lib/archive.ts";
import { waitForProcess, type ProcessInfo } from "../lib/process.ts";
import { LogClient, FACILITY, SEVERITY } from "../lib/logs.ts";
import { EXIT, ZopsError, usage } from "../lib/errors.ts";

interface AppVersion {
  id: string;
  uploadUrl: string;
  sequence: number;
  status: string;
}

const SHARED_FLAGS = [
  { name: "setup", type: "string" as const, placeholder: "<name>", description: "Which `setup:` block in zerops.yaml to use. Defaults to the service hostname." },
  { name: "version-name", type: "string" as const, placeholder: "<label>", description: "Label for this app version. Defaults to a timestamp." },
  { name: "working-dir", type: "string" as const, default: "./", placeholder: "<path>", description: "Directory to archive and to look for zerops.yaml in." },
  { name: "zerops-yaml", type: "string" as const, placeholder: "<path>", description: "Explicit path to zerops.yaml." },
  { name: "archive-file", type: "string" as const, placeholder: "<path>", description: "Also write the uploaded artifact to this .tar.gz, for inspection." },
];

function findZeropsYaml(ctx: Context, workingDir: string): string {
  const explicit = ctx.flag<string>("zerops-yaml");
  if (explicit) {
    const path = resolve(workingDir, explicit);
    if (!existsSync(path)) throw usage(`zerops.yaml not found at ${path}`);
    return path;
  }
  for (const name of ["zerops.yaml", "zerops.yml"]) {
    const path = join(workingDir, name);
    if (existsSync(path)) return path;
  }
  throw usage(
    `no zerops.yaml in ${workingDir}`,
    "Create one, or point at it with --zerops-yaml. It describes the build/run pipeline and belongs in the repository root.",
  );
}

/**
 * What the chosen setup will actually run, for the confirmation line below.
 *
 * A stale or wrong `zerops.yaml` builds, deploys and reports ACTIVE exactly like
 * the right one — the only symptom is the app misbehaving afterwards. Echoing
 * the resolved start command turns "it deployed" and "it deployed what I meant"
 * back into two distinguishable outcomes.
 */
function startCommandIn(yamlText: string, setup: string): string | null {
  try {
    const parsed = Bun.YAML.parse(yamlText) as {
      zerops?: {
        setup?: string;
        run?: { start?: string; startCommands?: { command?: string }[] };
      }[];
    };
    const found = (parsed?.zerops ?? []).find((s) => s.setup === setup);
    if (found?.run?.start) return found.run.start;
    const commands = found?.run?.startCommands ?? [];
    const named = commands.map((c) => c.command).filter(Boolean);
    return named.length > 0 ? named.join(" & ") : null;
  } catch {
    return null;
  }
}

/** Lists the `setup:` names so a mismatch can be reported locally with the valid options. */
function setupsIn(yamlText: string): string[] {
  try {
    const parsed = Bun.YAML.parse(yamlText) as { zerops?: { setup?: string }[] };
    return (parsed?.zerops ?? []).map((s) => s.setup).filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

async function createAndUpload(
  ctx: Context,
  service: ServiceSummary,
  options: { include?: string[]; noGit: boolean; workspaceState: WorkspaceState; includeGitFolder: boolean },
): Promise<AppVersion> {
  const workingDir = resolve(ctx.flag<string>("working-dir") ?? "./");
  const versionName = ctx.flag<string>("version-name") ?? new Date().toISOString().replace(/[:.]/g, "-");

  const packed = await packArtifact({
    workingDir,
    noGit: options.noGit,
    workspaceState: options.workspaceState,
    includeGitFolder: options.includeGitFolder,
    include: options.include,
    out: ctx.out,
  });

  try {
    const appVersion = await ctx.api.call<AppVersion>("createAppVersion", {
      path: { id: service.id },
      body: { name: versionName },
    });
    ctx.out.step(`app version #${appVersion.sequence} created (${appVersion.id})`);

    const archiveFile = ctx.flag<string>("archive-file");
    if (archiveFile) {
      await Bun.write(archiveFile, await new Response(gzipStream(packed.tarPath)).arrayBuffer());
      ctx.out.step(`artifact written to ${archiveFile}`);
    }

    // Streamed rather than buffered so repository size never becomes a memory ceiling.
    const response = await fetch(appVersion.uploadUrl, {
      method: "PUT",
      body: gzipStream(packed.tarPath),
      // Required by the fetch spec whenever the body is a stream.
      duplex: "half",
    });
    if (!response.ok) {
      throw new ZopsError({
        code: "uploadFailed",
        message: `artifact upload failed: HTTP ${response.status}`,
        exitCode: response.status >= 500 ? EXIT.TRANSIENT : EXIT.ERROR,
      });
    }
    ctx.out.step(`uploaded ${packed.fileCount} files (${(packed.byteSize / 1024).toFixed(0)} KiB uncompressed)`);
    return appVersion;
  } finally {
    await packed.cleanup();
  }
}

/**
 * Follows build and prepare-runtime logs while the pipeline runs.
 *
 * The builder is a temporary service of its own; its output is tagged `zbuilder@<appVersionId>`.
 * Without this the user watches a spinner and learns nothing about why a build failed.
 */
function attachPipelineLogs(ctx: Context, projectId: string, appVersionId: string, abort: AbortController) {
  const started = new Set<string>();

  const follow = async (serviceStackId: string, tags?: string[]) => {
    try {
      const logs = await LogClient.forProject(ctx, projectId);
      for await (const entry of logs.follow(
        { serviceStackId, tags, facility: FACILITY.APPLICATION, minimumSeverity: SEVERITY.DEBUG },
        abort.signal,
      )) {
        ctx.out.stderr(entry.message);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        ctx.out.debug(`pipeline log stream ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  return (proc: ProcessInfo) => {
    if (ctx.out.quiet || ctx.out.json) return;
    const buildService = proc.appVersion?.build?.serviceStackId;
    if (buildService && !started.has(buildService)) {
      started.add(buildService);
      ctx.out.info("--- build ---");
      void follow(buildService, [`zbuilder@${appVersionId}`]);
    }
    const prepareService = proc.appVersion?.prepareCustomRuntime?.serviceStackId;
    if (prepareService && !started.has(prepareService)) {
      started.add(prepareService);
      ctx.out.info("--- prepare runtime ---");
      void follow(prepareService);
    }
  };
}

async function runPipeline(
  ctx: Context,
  service: ServiceSummary,
  appVersion: AppVersion,
  operation: "buildAndDeployAppVersion" | "deployAppVersion",
  body: Record<string, unknown>,
): Promise<void> {
  const proc = await ctx.api.call<{ id: string }>(operation, { path: { id: appVersion.id }, body });

  if (!ctx.wait) {
    ctx.out.info(`pipeline started (process ${proc.id}); not waiting`);
    ctx.out.data({ appVersionId: appVersion.id, processId: proc.id, status: "PENDING", waited: false });
    return;
  }

  const projectId = await ctx.projectId();
  const abort = new AbortController();
  const onPoll = attachPipelineLogs(ctx, projectId, appVersion.id, abort);

  try {
    const finished = await waitForProcess(ctx, proc.id, { onPoll, timeoutMs: ctx.timeoutMs });
    abort.abort();
    // Let the last few buffered log lines land before the summary.
    await Bun.sleep(150);

    const fresh = await ctx.api.call<{ status: string; subdomainAccessUrl?: string }>("GetServiceStack", {
      path: { id: service.id },
    });
    ctx.out.step(`${service.name} is ${fresh.status}`);
    ctx.out.data({
      appVersionId: appVersion.id,
      processId: finished.id,
      status: finished.status,
      serviceStatus: fresh.status,
      url: fresh.subdomainAccessUrl ?? null,
      waited: true,
    });
  } catch (err) {
    abort.abort();
    await Bun.sleep(150);
    if (err instanceof ZopsError && err.exitCode === EXIT.REMOTE_FAILED) {
      throw new ZopsError({
        code: err.code,
        message: err.message,
        exitCode: EXIT.REMOTE_FAILED,
        hint: `Inspect the build output with \`zops logs ${service.name} --build --app-version ${appVersion.id}\`.`,
        details: { ...err.details, appVersionId: appVersion.id },
      });
    }
    throw err;
  }
}

export const deployCommands: CommandSpec[] = [
  {
    path: ["push"],
    summary: "Build on the platform and deploy: the normal way to ship a change.",
    description: `Archives the working directory, uploads it, and runs the build + deploy pipeline described by
zerops.yaml. Streams build logs to stderr and waits for the result, so the exit code reflects
whether the deployment actually succeeded:

  0  deployed and running
  7  still running when --timeout elapsed
  8  build or deploy failed (read the streamed log, or use \`zops logs --build\`)

In a git repository the archive contains tracked plus untracked-not-ignored files. Outside one,
or with --no-git, it contains the directory as it sits on disk. .deployignore applies either way.

One push deploys one setup. In a monorepo, run it once per service with --setup.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      ...SHARED_FLAGS,
      { name: "no-git", type: "boolean", description: "Archive the working directory as-is, ignoring git." },
      { name: "workspace-state", type: "string", enum: ["all", "clean"], default: "all", description: "all = working tree; clean = exactly HEAD." },
      { name: "deploy-git-folder", type: "boolean", description: "Include the .git directory in the artifact." },
      { name: "no-logs", type: "boolean", description: "Do not stream build logs while waiting." },
      { name: "skip-validation", type: "boolean", description: "Skip the server-side zerops.yaml check before uploading." },
    ],
    examples: [
      "zops push api",
      "zops push api --setup worker --version-name v1.4.2",
      "zops push api --json --timeout 20m",
      "zops push api --no-wait   # return as soon as the pipeline is queued",
    ],
    operations: ["ValidateZeropsYaml", "createAppVersion", "buildAndDeployAppVersion", "GetProcessDetails"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const workingDir = resolve(ctx.flag<string>("working-dir") ?? "./");
      const yamlPath = findZeropsYaml(ctx, workingDir);
      const yamlText = await readFile(yamlPath, "utf8");
      const setup = ctx.flag<string>("setup") ?? service.name;

      const available = setupsIn(yamlText);
      if (available.length > 0 && !available.includes(setup)) {
        throw usage(
          `setup '${setup}' is not defined in ${basename(yamlPath)}`,
          `Available setups: ${available.join(", ")}. Select one with --setup.`,
        );
      }

      if (!ctx.bool("skip-validation")) {
        await ctx.api.call("ValidateZeropsYaml", {
          body: {
            serviceStackName: service.name,
            serviceStackTypeId: service.serviceStackTypeId,
            serviceStackTypeVersionName: service.serviceStackTypeInfo?.serviceStackTypeVersionName,
            zeropsYaml: yamlText,
            zeropsYamlSetup: setup,
            operation: "BUILD_AND_DEPLOY",
          },
        });
        ctx.out.step(`${basename(yamlPath)} validated (setup: ${setup})`);
      }

      const start = startCommandIn(yamlText, setup);
      if (start !== null) ctx.out.info(`will run: ${start}`);

      if (ctx.dryRun) {
        return {
          dryRun: true,
          service: service.name,
          serviceId: service.id,
          setup,
          zeropsYaml: yamlPath,
          workingDir,
        };
      }

      const appVersion = await createAndUpload(ctx, service, {
        noGit: ctx.bool("no-git"),
        workspaceState: (ctx.flag<string>("workspace-state") as WorkspaceState) ?? "all",
        includeGitFolder: ctx.bool("deploy-git-folder"),
      });

      if (ctx.bool("no-logs")) ctx.out.info("build log streaming disabled");
      await runPipeline(ctx, service, appVersion, "buildAndDeployAppVersion", {
        zeropsYaml: yamlText,
        zeropsYamlSetup: setup,
      });
    },
  },
  {
    path: ["deploy"],
    summary: "Deploy prebuilt artifacts, skipping the build phase.",
    description: `Uploads exactly the paths you name and runs only the deploy phase. Use this when the build
already happened — in CI, for instance — and you just want the result shipped.

zerops.yaml is still sent, because the run: section defines how the service starts. Unlike push,
the files come from the paths given on the command line rather than from deployFiles.`,
    args: [
      { name: "service", description: "Service hostname or id. Defaults to --service.", required: true },
      { name: "paths", description: "Files and directories to deploy. Defaults to the working directory.", variadic: true },
    ],
    flags: [...SHARED_FLAGS],
    examples: [
      "zops deploy api ./dist ./package.json",
      "zops deploy api ./build --version-name ci-$GITHUB_SHA",
    ],
    operations: ["createAppVersion", "deployAppVersion", "GetProcessDetails"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const include = parsed.args.slice(1);
      const workingDir = resolve(ctx.flag<string>("working-dir") ?? "./");
      const setup = ctx.flag<string>("setup") ?? service.name;

      // zerops.yaml is optional here: a service whose run: section never changes can redeploy
      // without one, and the platform reuses the previous configuration.
      let yamlText: string | undefined;
      try {
        yamlText = await readFile(findZeropsYaml(ctx, workingDir), "utf8");
      } catch {
        ctx.out.info("no zerops.yaml found; deploying with the service's existing run configuration");
      }

      if (ctx.dryRun) {
        return { dryRun: true, service: service.name, setup, include: include.length ? include : ["."], workingDir };
      }

      const appVersion = await createAndUpload(ctx, service, {
        include: include.length > 0 ? include : ["."],
        noGit: true,
        workspaceState: "all",
        includeGitFolder: false,
      });

      await runPipeline(ctx, service, appVersion, "deployAppVersion", {
        ...(yamlText ? { zeropsYaml: yamlText, zeropsYamlSetup: setup } : {}),
      });
    },
  },
];
