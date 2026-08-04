/**
 * Git repository integration — the `buildFromGit` path.
 *
 * Two different things live here and are easy to confuse. An *integration* is a persistent
 * webhook: Zerops watches a branch or tag pattern on GitHub/GitLab and builds on every push.
 * A *pipeline trigger* is a one-shot build of whatever the service is already pointed at, or of
 * a repository URL passed inline. `zz push` is neither — that uploads the working tree.
 *
 * Connecting an integration needs the account's OAuth grant for the provider, which only the
 * GUI can obtain. `authorizationRequired` in the status is how that shows up.
 */
import type { CommandSpec, FlagSpec } from "../lib/spec.ts";
import type { Context } from "../lib/context.ts";
import { settleProcess } from "../lib/process.ts";
import { notFound, usage } from "../lib/errors.ts";

type Provider = "github" | "gitlab";

/** What the status endpoint reports back. `triggerBuild` is request-only and absent here. */
interface Integration {
  repositoryFullName: string;
  eventType: "BRANCH" | "TAG";
  branchName?: string | null;
  tagRegex?: string | null;
  isActive: boolean;
  zeropsYamlSetup?: string | null;
  authorizationRequired?: boolean;
  webhookId?: string | null;
}

interface IntegrationRequest {
  repositoryFullName: string;
  eventType: "BRANCH" | "TAG";
  branchName: string | null;
  tagRegex: string | null;
  zeropsYamlSetup: string | null;
  isActive: boolean;
  triggerBuild: boolean;
}

interface IntegrationStatus {
  githubIntegration?: Integration | null;
  gitlabIntegration?: Integration | null;
}

const PROVIDER_FLAG: FlagSpec = {
  name: "provider",
  type: "string",
  enum: ["github", "gitlab"],
  default: "github",
  description: "Which forge the repository lives on.",
};

/** The flag is enum-validated by the parser, so anything but the two values means it was absent. */
function provider(ctx: Context): Provider {
  return ctx.flag<string>("provider") === "gitlab" ? "gitlab" : "github";
}

/** The status response keys the integration by provider; this collapses it to one pair. */
function currentIntegration(status: IntegrationStatus): { provider: Provider; integration: Integration } | null {
  if (status.githubIntegration) return { provider: "github", integration: status.githubIntegration };
  if (status.gitlabIntegration) return { provider: "gitlab", integration: status.gitlabIntegration };
  return null;
}

function integrationBody(target: Provider, integration: IntegrationRequest): Record<string, unknown> {
  return { [`${target}Integration`]: integration };
}

export const repoCommands: CommandSpec[] = [
  {
    path: ["repo", "status"],
    summary: "Show the Git integration configured for a service.",
    description: `Reports which repository the service watches, whether the hook is active, and whether the
account still needs to authorize Zerops against the forge.

\`authorizationRequired: true\` means the integration exists but cannot fire — grant access in
the Zerops GUI (Settings → Account access) and it starts working without reconfiguration.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz repo status api", "zz repo status api --json"],
    operations: ["GetExternalRepositoryIntegrationStatus"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const status = await ctx.api.call<IntegrationStatus>("GetExternalRepositoryIntegrationStatus", {
        path: { id: service.id },
      });
      const current = currentIntegration(status);
      if (!current) {
        ctx.out.info(`${service.name} has no Git integration`);
        ctx.out.data({ service: service.name, connected: false, provider: null });
        return;
      }
      ctx.out.data({
        service: service.name,
        connected: true,
        provider: current.provider,
        repository: current.integration.repositoryFullName,
        eventType: current.integration.eventType,
        branch: current.integration.branchName ?? null,
        tagRegex: current.integration.tagRegex ?? null,
        active: current.integration.isActive,
        setup: current.integration.zeropsYamlSetup ?? null,
        authorizationRequired: current.integration.authorizationRequired ?? false,
      });
    },
  },
  {
    path: ["repo", "connect"],
    summary: "Watch a GitHub/GitLab repository and build on push.",
    description: `Registers the webhook and, unless --no-build is passed, builds immediately from the current
head. Pass exactly one of --branch or --tag-regex: a branch integration fires on every push to
that branch, a tag integration on every tag matching the pattern.

The forge account must already be authorized — run \`zz repo list\` first; an empty list with an
auth error means the grant is missing and has to be made in the GUI.`,
    args: [
      { name: "repository", description: "Repository in owner/name form, e.g. acme/api.", required: true },
      { name: "service", description: "Service hostname or id. Defaults to --service." },
    ],
    flags: [
      PROVIDER_FLAG,
      { name: "branch", type: "string", placeholder: "<name>", description: "Branch to watch. Mutually exclusive with --tag-regex." },
      { name: "tag-regex", type: "string", placeholder: "<regex>", description: "Tag pattern to watch, e.g. '^v[0-9]'. Mutually exclusive with --branch." },
      { name: "setup", type: "string", placeholder: "<name>", description: "zerops.yaml setup: block to build. Defaults to the service name." },
      { name: "build", type: "boolean", default: true, description: "Build right away. Use --no-build to only register the hook." },
      { name: "inactive", type: "boolean", description: "Register the hook but leave it disabled." },
    ],
    examples: [
      "zz repo connect acme/api api --branch main",
      "zz repo connect acme/api api --tag-regex '^v[0-9]' --setup api",
      "zz repo connect acme/api api --branch main --no-build",
    ],
    operations: ["SetupExternalRepositoryIntegration"],
    async run(ctx, parsed) {
      const repository = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      const target = provider(ctx);
      const branch = ctx.flag<string>("branch");
      const tagRegex = ctx.flag<string>("tag-regex");

      if (Boolean(branch) === Boolean(tagRegex)) {
        throw usage(
          "pass exactly one of --branch or --tag-regex",
          "A branch integration builds on push to that branch; a tag integration builds on matching tags.",
        );
      }

      const integration: IntegrationRequest = {
        repositoryFullName: repository,
        eventType: branch ? "BRANCH" : "TAG",
        branchName: branch ?? null,
        tagRegex: tagRegex ?? null,
        zeropsYamlSetup: ctx.flag<string>("setup") ?? null,
        isActive: !ctx.bool("inactive"),
        triggerBuild: ctx.flags.build !== false,
      };

      const body = integrationBody(target, integration);
      if (ctx.dryRun) {
        return { dryRun: true, operation: "SetupExternalRepositoryIntegration", service: service.name, body };
      }

      const res = await ctx.api.call("SetupExternalRepositoryIntegration", { path: { id: service.id }, body });
      const settled = await settleProcess(ctx, res, `connecting ${service.name} to ${target}:${repository}`);
      ctx.out.data({ ...settled, service: service.name, provider: target, repository });
    },
  },
  {
    path: ["repo", "disable"],
    summary: "Stop building on push without discarding the integration.",
    description: "Re-sends the existing configuration with the hook deactivated. `zz repo connect` re-enables it.",
    destructive: true,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz repo disable api --yes"],
    operations: ["GetExternalRepositoryIntegrationStatus", "SetupExternalRepositoryIntegration"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const status = await ctx.api.call<IntegrationStatus>("GetExternalRepositoryIntegrationStatus", {
        path: { id: service.id },
      });
      const current = currentIntegration(status);
      if (!current) throw notFound(`${service.name} has no Git integration`, "Run `zz repo status`.");
      if (!current.integration.isActive) {
        ctx.out.info(`${service.name} already has the integration disabled`);
        ctx.out.data({ service: service.name, active: false, changed: false });
        return;
      }

      await ctx.confirm(`disable the ${current.provider} integration on ${service.name}`);
      const disabled: IntegrationRequest = {
        repositoryFullName: current.integration.repositoryFullName,
        eventType: current.integration.eventType,
        branchName: current.integration.branchName ?? null,
        tagRegex: current.integration.tagRegex ?? null,
        zeropsYamlSetup: current.integration.zeropsYamlSetup ?? null,
        isActive: false,
        triggerBuild: false,
      };
      const body = integrationBody(current.provider, disabled);

      if (ctx.dryRun) return { dryRun: true, operation: "SetupExternalRepositoryIntegration", body };
      const res = await ctx.api.call("SetupExternalRepositoryIntegration", { path: { id: service.id }, body });
      const settled = await settleProcess(ctx, res, `disabling the ${current.provider} integration`);
      ctx.out.data({ ...settled, service: service.name, active: false, changed: true });
    },
  },
  {
    path: ["repo", "build"],
    summary: "Build now from the connected repository.",
    description: `Runs the integration's pipeline against the repository's current head without waiting for a
push. Use it to retry a build that failed for an environmental reason, or to pick up a change
made before the integration existed.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "env-file", type: "string", placeholder: "<path>", description: "Build-time variables in .env format, applied to this build only." },
    ],
    examples: ["zz repo build api", "zz repo build api --no-wait"],
    operations: ["TriggerExternalRepositoryIntegration"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const envFile = ctx.flag<string>("env-file");
      const body: Record<string, unknown> = {};
      if (envFile) body.userDataEnvFile = await Bun.file(envFile).text();

      if (ctx.dryRun) {
        return { dryRun: true, operation: "TriggerExternalRepositoryIntegration", service: service.name, body };
      }
      const res = await ctx.api.call("TriggerExternalRepositoryIntegration", {
        path: { id: service.id },
        body,
      });
      ctx.out.data(await settleProcess(ctx, res, `building ${service.name} from its repository`));
    },
  },
  {
    path: ["repo", "list"],
    summary: "List repositories the linked forge account can reach.",
    description: `Reads the OAuth grant, so it doubles as an authorization check: an auth error here means
Zerops has no access to the forge and \`zz repo connect\` will not work yet.`,
    flags: [PROVIDER_FLAG, { name: "search", type: "string", placeholder: "<substring>", description: "Only repositories whose full name contains this." }],
    examples: ["zz repo list", "zz repo list --provider gitlab -q"],
    operations: ["getGithubRepositories", "getGitlabRepositories"],
    async run(ctx) {
      const target = provider(ctx);
      const operation = target === "github" ? "getGithubRepositories" : "getGitlabRepositories";
      const res = await ctx.api.call<{ repositories?: { fullName: string; name: string; owner: string; visibility: string; admin: boolean }[] }>(
        operation,
      );
      let items = res.repositories ?? [];
      const search = ctx.flag<string>("search")?.toLowerCase();
      if (search) items = items.filter((r) => r.fullName.toLowerCase().includes(search));
      ctx.out.data(items, {
        columns: [
          { key: "fullName", header: "REPOSITORY" },
          { key: "visibility", header: "VISIBILITY" },
          { key: "admin", header: "ADMIN" },
        ],
        quietField: "fullName",
        emptyMessage: `no ${target} repositories — the account may not be authorized`,
      });
    },
  },
  {
    path: ["repo", "branches"],
    summary: "List branches of a repository on the linked forge account.",
    args: [{ name: "repository", description: "Repository in owner/name form.", required: true }],
    flags: [PROVIDER_FLAG],
    examples: ["zz repo branches acme/api", "zz repo branches acme/api -q"],
    operations: ["getGithubRepositoryBranches", "getGitlabRepositoryBranches"],
    async run(ctx, parsed) {
      const operation =
        provider(ctx) === "github" ? "getGithubRepositoryBranches" : "getGitlabRepositoryBranches";
      const res = await ctx.api.call<{ branches?: { name: string; isDefault: boolean }[] }>(operation, {
        query: { repositoryFullName: parsed.args[0]! },
      });
      ctx.out.data(res.branches ?? [], {
        columns: [
          { key: "name", header: "BRANCH" },
          { key: "isDefault", header: "DEFAULT" },
        ],
        quietField: "name",
        emptyMessage: "no branches",
      });
    },
  },
];

export const pipelineCommands: CommandSpec[] = [
  {
    path: ["pipeline", "trigger"],
    summary: "Run a build/deploy pipeline for a service, optionally from a public Git URL.",
    description: `The general-purpose pipeline entry point behind \`zz push\` and \`zz repo build\`. Reach for it
when neither fits:

  --from-git   build from any Git URL, with no webhook and no forge authorization. This is the
               same mechanism as \`buildFromGit\` in an import YAML.
  --app-version  re-run the pipeline for an existing app version.
  --start-without-code  bring the service up with no application code, for a container you
               intend to fill over SSH.

Supplying --zerops-yaml overrides the configuration in the repository for this run only.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "from-git", type: "string", placeholder: "<url>", description: "Git URL to build from, optionally with a @branch or @tag suffix." },
      { name: "app-version", type: "string", placeholder: "<id>", description: "Re-run the pipeline for this existing app version." },
      { name: "setup", type: "string", placeholder: "<name>", description: "zerops.yaml setup: block to use. Defaults to the service name." },
      { name: "zerops-yaml", type: "string", placeholder: "<path>", description: "Use this zerops.yaml instead of the one in the repository." },
      { name: "env-file", type: "string", placeholder: "<path>", description: "Build-time variables in .env format, applied to this run only." },
      { name: "start-without-code", type: "boolean", description: "Start the service with no application code." },
    ],
    examples: [
      "zz pipeline trigger api --from-git https://github.com/acme/api@main",
      "zz pipeline trigger api --app-version 3mKq8vNwQ1yTbXZs2LpAcd",
      "zz pipeline trigger worker --start-without-code",
    ],
    operations: ["PutTriggerPipeline"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const body: Record<string, unknown> = {};

      const fromGit = ctx.flag<string>("from-git");
      const appVersion = ctx.flag<string>("app-version");
      const zeropsYaml = ctx.flag<string>("zerops-yaml");
      const envFile = ctx.flag<string>("env-file");

      if (fromGit) body.buildFromGit = fromGit;
      if (appVersion) body.appVersionId = appVersion;
      if (ctx.flag<string>("setup")) body.zeropsSetup = ctx.flag<string>("setup");
      if (zeropsYaml) body.zeropsYaml = await Bun.file(zeropsYaml).text();
      if (envFile) body.userDataEnvFile = await Bun.file(envFile).text();
      if (ctx.bool("start-without-code")) body.startWithoutCode = true;

      if (Object.keys(body).length === 0) {
        throw usage(
          "nothing to trigger",
          "Pass --from-git, --app-version or --start-without-code. To deploy the working tree, use `zz push`.",
        );
      }

      if (ctx.dryRun) return { dryRun: true, operation: "PutTriggerPipeline", service: service.name, body };
      const res = await ctx.api.call("PutTriggerPipeline", { path: { id: service.id }, body });
      ctx.out.data(await settleProcess(ctx, res, `running the pipeline for ${service.name}`));
    },
  },
];
