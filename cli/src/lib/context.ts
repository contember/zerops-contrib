/**
 * Per-invocation context: resolved config, the API client, the output channel, and the
 * name -> id resolution that lets every command accept human identifiers.
 *
 * Agents work from names (`api`, `db`), not 22-character ids, so resolution is a first-class
 * concern rather than something each command reimplements.
 */
import { ApiClient } from "./http.ts";
import { Output } from "./output.ts";
import { loadConfig, type ResolvedConfig } from "./config.ts";
import { EXIT, ZzError, authError, notFound, usage } from "./errors.ts";
import { parseDuration, type ParsedArgs } from "./spec.ts";

/** Zerops ids are 22-character base62 strings. */
const ID_RE = /^[a-zA-Z0-9]{22}$/;
export const looksLikeId = (s: string): boolean => ID_RE.test(s);

export interface ServiceSummary {
  id: string;
  name: string;
  status: string;
  serviceStackTypeId?: string;
  serviceStackTypeVersionId?: string;
  serviceStackTypeInfo?: {
    serviceStackTypeName?: string;
    serviceStackTypeCategory?: string;
    serviceStackTypeVersionName?: string;
  };
  [key: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  clientId: string;
  [key: string]: unknown;
}

export class Context {
  readonly out: Output;
  readonly api: ApiClient;
  readonly config: ResolvedConfig;
  readonly flags: ParsedArgs["flags"];
  readonly args: string[];
  readonly rest: string[];

  private cachedClientId?: string;
  private cachedProject?: ProjectSummary;
  private readonly serviceCache = new Map<string, ServiceSummary>();

  constructor(parsed: ParsedArgs) {
    this.flags = parsed.flags;
    this.args = parsed.args;
    this.rest = parsed.rest;
    this.out = new Output({
      json: parsed.flags.json as boolean,
      quiet: parsed.flags.quiet as boolean,
      verbose: parsed.flags.verbose as boolean,
    });
    this.config = loadConfig({
      token: parsed.flags.token as string | undefined,
      region: parsed.flags.region as string | undefined,
      project: parsed.flags.project as string | undefined,
      service: parsed.flags.service as string | undefined,
    });
    this.api = new ApiClient(this.config.apiUrl, this.config.token, this.out);
  }

  // --- flag helpers --------------------------------------------------------

  flag<T = string>(name: string): T | undefined {
    return this.flags[name] as T | undefined;
  }

  bool(name: string): boolean {
    return this.flags[name] === true;
  }

  get dryRun(): boolean {
    return this.bool("dry-run");
  }

  get wait(): boolean {
    return this.flags.wait !== false;
  }

  get timeoutMs(): number {
    return parseDuration((this.flags.timeout as string | undefined) ?? "10m");
  }

  requireToken(): string {
    if (!this.config.token) {
      throw authError(
        "no access token configured",
        "Run `zz auth login <token>`, or set ZEROPS_TOKEN. Create a token in the Zerops GUI under Settings → Access Token Management.",
      );
    }
    return this.config.token;
  }

  /**
   * Confirmation gate for destructive commands. Non-interactive callers are never prompted —
   * they must pass `--yes`, which keeps an agent from hanging on a prompt it cannot answer.
   */
  async confirm(what: string): Promise<void> {
    if (this.bool("yes") || this.dryRun) return;
    if (!process.stdin.isTTY) {
      throw usage(
        `refusing to ${what} without confirmation`,
        "Re-run with --yes to confirm, or --dry-run to preview.",
      );
    }
    process.stderr.write(`About to ${what}. Continue? [y/N] `);
    for await (const line of console) {
      const answer = line.trim().toLowerCase();
      if (answer === "y" || answer === "yes") return;
      throw new ZzError({ code: "aborted", message: "aborted by user", exitCode: EXIT.USAGE });
    }
    throw new ZzError({ code: "aborted", message: "aborted — no input", exitCode: EXIT.USAGE });
  }

  // --- identity ------------------------------------------------------------

  /** The organization ("client") the token belongs to. */
  async clientId(): Promise<string> {
    if (this.cachedClientId) return this.cachedClientId;
    this.requireToken();
    const info = await this.api.call<{
      clientUserList?: { clientId: string; status: string }[];
    }>("GetUserInfo");
    const active = info.clientUserList?.find((c) => c.status === "ACTIVE") ?? info.clientUserList?.[0];
    if (!active) {
      throw notFound("token is not connected to any organization");
    }
    this.cachedClientId = active.clientId;
    return active.clientId;
  }

  // --- projects ------------------------------------------------------------

  async project(): Promise<ProjectSummary> {
    if (this.cachedProject) return this.cachedProject;
    const ref = this.config.project;
    if (!ref) {
      throw usage(
        "no project selected",
        "Pass --project <name|id>, set ZEROPS_PROJECT, or run `zz project list` to see the options.",
      );
    }
    this.cachedProject = await this.resolveProject(ref);
    return this.cachedProject;
  }

  async projectId(): Promise<string> {
    return (await this.project()).id;
  }

  /**
   * Accepts an id or a name. Ids are tried directly; a 404 falls through to a name lookup,
   * because a 22-character name is legal even if unusual.
   */
  async resolveProject(ref: string): Promise<ProjectSummary> {
    if (looksLikeId(ref)) {
      try {
        return await this.api.call<ProjectSummary>("GetProjectDetails", { path: { id: ref } });
      } catch (err) {
        if (!(err instanceof ZzError) || err.exitCode !== EXIT.NOT_FOUND) throw err;
      }
    }
    const clientId = await this.clientId();
    const found = await this.api.call<{ items?: ProjectSummary[]; list?: ProjectSummary[] }>(
      "GetClientProjectsByName",
      { path: { id: clientId, name: ref } },
    );
    const items = found.items ?? found.list ?? [];
    if (items.length === 0) {
      throw notFound(`no project named '${ref}'`, "Run `zz project list` to see available projects.");
    }
    if (items.length > 1) {
      throw usage(
        `'${ref}' matches ${items.length} projects: ${items.map((p) => p.id).join(", ")}`,
        "Pass the project id instead of the name.",
      );
    }
    return items[0]!;
  }

  // --- services ------------------------------------------------------------

  /** Resolves the service from the argument, else --service/$ZEROPS_SERVICE. */
  async service(ref?: string): Promise<ServiceSummary> {
    const target = ref ?? this.config.service;
    if (!target) {
      throw usage(
        "no service selected",
        "Pass the service as an argument or --service <hostname|id>, or run `zz service list`.",
      );
    }
    const cached = this.serviceCache.get(target);
    if (cached) return cached;

    let resolved: ServiceSummary | undefined;
    if (looksLikeId(target)) {
      try {
        resolved = await this.api.call<ServiceSummary>("GetServiceStack", { path: { id: target } });
      } catch (err) {
        if (!(err instanceof ZzError) || err.exitCode !== EXIT.NOT_FOUND) throw err;
      }
    }
    if (!resolved) {
      const projectId = await this.projectId();
      try {
        resolved = await this.api.call<ServiceSummary>("GetServiceStackByName", {
          path: { projectId, name: target },
        });
      } catch (err) {
        if (err instanceof ZzError && err.exitCode === EXIT.NOT_FOUND) {
          const available = await this.listServices();
          throw notFound(
            `no service named '${target}' in project ${(await this.project()).name}`,
            available.length
              ? `Available services: ${available.map((s) => s.name).join(", ")}`
              : "This project has no services yet.",
          );
        }
        throw err;
      }
    }
    this.serviceCache.set(target, resolved);
    this.serviceCache.set(resolved.id, resolved);
    return resolved;
  }

  async serviceId(ref?: string): Promise<string> {
    return (await this.service(ref)).id;
  }

  async listServices(): Promise<ServiceSummary[]> {
    const projectId = await this.projectId();
    const res = await this.api.call<{ items?: ServiceSummary[]; list?: ServiceSummary[] }>(
      "ListProjectServiceStacks",
      { path: { id: projectId }, query: { limit: 1000 } },
    );
    return res.items ?? res.list ?? [];
  }
}
