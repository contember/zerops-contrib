/**
 * Credential and context resolution.
 *
 * Precedence is flag > environment > project config file > profile or user config file, which
 * lets a repo pin its project while CI overrides the token, and lets an agent override either
 * without editing anything on disk. A selected profile takes the place of the top-level settings
 * in the user config file; it does not layer over them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ZopsError, authError, usage } from "./errors.ts";

export interface StoredConfig {
  token?: string;
  region?: string;
  project?: string;
  service?: string;
}

/**
 * Settings for one organization. A Zerops token belongs to exactly one organization, so a
 * profile is how a user who works for several switches between them.
 */
export interface ProfileConfig extends StoredConfig {
  /**
   * Shell command that prints the token on stdout, e.g. a keychain lookup, so the secret never
   * has to sit in the config file. Run only when a command actually needs the token.
   */
  tokenCommand?: string;
}

/** Shape of the user config file. The top-level keys are the setup used when no profile is selected. */
export interface UserConfigFile extends ProfileConfig {
  /** Profile selected by `zops profile use`. */
  profile?: string;
  profiles?: Record<string, ProfileConfig>;
}

export interface ResolvedConfig {
  /**
   * Resolved lazily: a profile's tokenCommand runs on first access, so commands that never call
   * the API (`zops profile list`) never touch the keychain. Throws when the selected profile does
   * not exist or its command fails.
   */
  readonly token: string | undefined;
  region: string;
  project?: string;
  service?: string;
  apiUrl: string;
  /** Files that contributed, most-significant last. Reported by `zops auth status`. */
  sources: string[];
  /** The profile in effect, if any. */
  profile?: string;
  /** Where the profile selection came from: `flag`, `environment` or the user config path. */
  profileSource?: string;
  /** Where the token came from, never the token itself. */
  tokenSource?: string;
  /** Non-fatal surprises for the caller to print, e.g. an ambient token shadowing the profile. */
  warnings: string[];
}

const USER_CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zops", "config.json");

/** `prg1` -> `https://api.app-prg1.zerops.io`. $ZEROPS_API_URL overrides for self-hosted/staging. */
export function apiUrlForRegion(region: string): string {
  const override = process.env.ZEROPS_API_URL;
  if (override) return override.replace(/\/+$/, "");
  return `https://api.app-${region}.zerops.io`;
}

function readJsonish(path: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(path, "utf8");
    if (path.endsWith(".json")) return JSON.parse(text) as Record<string, unknown>;
    return (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Nearest config file walking up from `start` to the filesystem root. */
function findProjectConfig(start: string): { path: string; data: Record<string, unknown> } | null {
  let dir = resolve(start);
  for (;;) {
    for (const name of [".zops.json", ".zops.yaml", ".zops.yml", ".zcli.yaml", ".zcli.yml"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const data = readJsonish(candidate);
        if (data) return { path: candidate, data };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export interface ConfigOverrides {
  token?: string;
  region?: string;
  project?: string;
  service?: string;
  profile?: string;
  /** Names of the overrides that came from an environment variable rather than the command line. */
  fromEnv?: Set<string>;
  cwd?: string;
  /** Path of the user config file; tests point it elsewhere. */
  userConfig?: string;
}

interface Layer {
  source: string;
  values: StoredConfig;
  tokenCommand?: string;
}

function readStored(data: Record<string, unknown>): StoredConfig {
  return { token: str(data.token), region: str(data.region), project: str(data.project), service: str(data.service) };
}

export function loadConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const userPath = overrides.userConfig ?? USER_CONFIG;
  const user = readJsonish(userPath) as (UserConfigFile & Record<string, unknown>) | null;
  const layers: Layer[] = [];
  const warnings: string[] = [];

  // Profile selection: flag > environment > `zops profile use`. A repo config file cannot select
  // a profile: it would fail in CI and on every machine that names its profiles differently.
  const flagProfile = overrides.fromEnv?.has("profile") ? undefined : str(overrides.profile);
  const envProfile = str(process.env.ZEROPS_PROFILE) ?? (overrides.fromEnv?.has("profile") ? str(overrides.profile) : undefined);
  let profile: string | undefined;
  let profileSource: string | undefined;
  if (flagProfile) [profile, profileSource] = [flagProfile, "flag"];
  else if (envProfile) [profile, profileSource] = [envProfile, "environment"];
  else if (user && str(user.profile)) [profile, profileSource] = [str(user.profile), userPath];

  let profileError: ZopsError | undefined;
  if (profile) {
    const profiles = user?.profiles && typeof user.profiles === "object" ? user.profiles : {};
    const entry = profiles[profile] as Record<string, unknown> | undefined;
    if (entry && typeof entry === "object") {
      // The profile replaces the top-level setup instead of layering over it: inheriting the
      // default token or project would silently act on another organization.
      layers.push({ source: `${userPath} (profile ${profile})`, values: readStored(entry), tokenCommand: str(entry.tokenCommand) });
    } else {
      const names = Object.keys(profiles);
      profileError = usage(
        `no profile named '${profile}'`,
        names.length
          ? `Available profiles: ${names.join(", ")}. Run \`zops profile list\`.`
          : `No profiles are configured. Create one with \`zops auth login --profile ${profile} --token-command '<cmd>'\`.`,
      );
    }
  } else if (user) {
    layers.push({ source: userPath, values: readStored(user), tokenCommand: str(user.tokenCommand) });
  }

  const project = findProjectConfig(overrides.cwd ?? process.cwd());
  if (project) {
    const d = project.data;
    // `.zcli.yaml` uses projectId/serviceId; accept both spellings so an existing repo works as-is.
    // A repo file never gets a tokenCommand: cloning a repo must not make zops run its commands.
    layers.push({
      source: project.path,
      values: {
        token: str(d.token),
        region: str(d.region),
        project: str(d.project) ?? str(d.projectId),
        service: str(d.service) ?? str(d.serviceId),
      },
    });
  }

  // Environment beats both files. ZEROPS_PROJECT_ID / ZEROPS_SERVICE_ID are the names the
  // platform itself injects into containers, so they are accepted as aliases.
  layers.push({
    source: "environment",
    values: {
      token: str(process.env.ZEROPS_TOKEN),
      region: str(process.env.ZEROPS_REGION),
      project: str(process.env.ZEROPS_PROJECT) ?? str(process.env.ZEROPS_PROJECT_ID),
      service: str(process.env.ZEROPS_SERVICE) ?? str(process.env.ZEROPS_SERVICE_ID),
    },
  });

  // The argument parser folds environment fallbacks into its flags; those are already the
  // environment layer above, so only values typed on the command line count as flags here.
  const flagValues: StoredConfig = {};
  for (const key of ["token", "region", "project", "service"] as const) {
    if (!overrides.fromEnv?.has(key) && str(overrides[key])) flagValues[key] = overrides[key];
  }
  layers.push({ source: "flags", values: flagValues });

  const merged: StoredConfig = {};
  const sources: string[] = [];
  for (const layer of layers) {
    const contributes = Object.values(layer.values).some((v) => v !== undefined) || layer.tokenCommand !== undefined;
    if (contributes) sources.push(layer.source);
    for (const [k, v] of Object.entries(layer.values)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }

  // The token comes from the most significant layer that has one; within a layer a literal
  // token beats a tokenCommand.
  const tokenLayer = [...layers].reverse().find((l) => l.values.token !== undefined || l.tokenCommand !== undefined);
  const viaCommand = tokenLayer !== undefined && tokenLayer.values.token === undefined;
  const tokenSource = tokenLayer
    ? (tokenLayer.source === layers[0]?.source && profile
        ? `profile ${profile}`
        : tokenLayer.source === "flags"
          ? "flag"
          : tokenLayer.source) + (viaCommand ? " (tokenCommand)" : "")
    : undefined;

  const profileLayer = profile && !profileError ? layers[0] : undefined;
  if (profileLayer && tokenLayer && tokenLayer !== profileLayer && tokenLayer.source !== "flags") {
    if (profileLayer.values.token !== undefined || profileLayer.tokenCommand !== undefined) {
      const name = tokenLayer.source === "environment" ? "ZEROPS_TOKEN" : `the token in ${tokenLayer.source}`;
      warnings.push(`${name} overrides the token of profile '${profile}'`);
    }
  }

  let token: string | undefined;
  let tokenResolved = false;
  const region = merged.region ?? "prg1";
  return {
    get token() {
      if (profileError) throw profileError;
      if (!tokenResolved) {
        token = viaCommand ? runTokenCommand(tokenLayer!.tokenCommand!, profile) : tokenLayer?.values.token;
        tokenResolved = true;
      }
      return token;
    },
    region,
    project: merged.project,
    service: merged.service,
    apiUrl: apiUrlForRegion(region),
    sources,
    profile,
    profileSource,
    tokenSource,
    warnings,
  };
}

/**
 * Runs a tokenCommand and returns its trimmed stdout. stderr is captured, not passed through,
 * so the error envelope on stderr stays parseable; it is quoted in the error instead.
 */
export function runTokenCommand(command: string, profile?: string): string {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["/bin/sh", "-c", command];
  const label = profile ? `token command of profile '${profile}'` : "token command";
  const proc = Bun.spawnSync(shell, { stdin: "inherit", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (!proc.success) {
    const stderr = proc.stderr.toString().trim().slice(0, 300);
    const status = proc.exitCode === null ? `was killed (${proc.signalCode ?? "timeout"})` : `exited with ${proc.exitCode}`;
    throw authError(
      `${label} ${status}${stderr ? `: ${stderr}` : ""}`,
      `Run the command yourself to check it: ${command}`,
    );
  }
  const token = proc.stdout.toString().trim();
  if (!token) throw authError(`${label} printed nothing`, `Run the command yourself to check it: ${command}`);
  return token;
}

/**
 * Read-modify-write of the user config file. Keys set to undefined are dropped, so a caller can
 * delete by assignment.
 */
export function updateUserConfig(mutate: (config: UserConfigFile) => void, path = USER_CONFIG): string {
  const config = (readJsonish(path) ?? {}) as UserConfigFile;
  mutate(config);
  const prune = (o: Record<string, unknown>) => {
    for (const key of Object.keys(o)) if (o[key] === undefined) delete o[key];
  };
  prune(config as Record<string, unknown>);
  for (const entry of Object.values(config.profiles ?? {})) prune(entry as Record<string, unknown>);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  // The file may hold a bearer token; keep it out of reach of other local users.
  chmodSync(path, 0o600);
  return path;
}

export function readUserConfig(path = USER_CONFIG): UserConfigFile {
  return (readJsonish(path) ?? {}) as UserConfigFile;
}

export function saveUserConfig(patch: StoredConfig & { tokenCommand?: string }): string {
  return updateUserConfig((config) => Object.assign(config, patch));
}

export const userConfigPath = USER_CONFIG;
