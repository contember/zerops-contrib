/**
 * Credential and context resolution.
 *
 * Precedence is flag > environment > project config file > user config file, which lets a repo
 * pin its project while CI overrides the token, and lets an agent override either without
 * editing anything on disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface StoredConfig {
  token?: string;
  region?: string;
  project?: string;
  service?: string;
}

export interface ResolvedConfig extends StoredConfig {
  apiUrl: string;
  /** Files that contributed, most-significant last. Reported by `zops auth status`. */
  sources: string[];
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
  cwd?: string;
}

export function loadConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const sources: string[] = [];
  const merged: StoredConfig = {};

  const user = readJsonish(USER_CONFIG);
  if (user) {
    sources.push(USER_CONFIG);
    Object.assign(merged, {
      token: str(user.token),
      region: str(user.region),
      project: str(user.project),
      service: str(user.service),
    });
  }

  const project = findProjectConfig(overrides.cwd ?? process.cwd());
  if (project) {
    sources.push(project.path);
    const d = project.data;
    // `.zcli.yaml` uses projectId/serviceId; accept both spellings so an existing repo works as-is.
    const fromFile: StoredConfig = {
      token: str(d.token),
      region: str(d.region),
      project: str(d.project) ?? str(d.projectId),
      service: str(d.service) ?? str(d.serviceId),
    };
    for (const [k, v] of Object.entries(fromFile)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }

  // Environment beats both files. ZEROPS_PROJECT_ID / ZEROPS_SERVICE_ID are the names the
  // platform itself injects into containers, so they are accepted as aliases.
  const env: StoredConfig = {
    token: str(process.env.ZEROPS_TOKEN),
    region: str(process.env.ZEROPS_REGION),
    project: str(process.env.ZEROPS_PROJECT) ?? str(process.env.ZEROPS_PROJECT_ID),
    service: str(process.env.ZEROPS_SERVICE) ?? str(process.env.ZEROPS_SERVICE_ID),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      (merged as Record<string, unknown>)[k] = v;
      if (!sources.includes("environment")) sources.push("environment");
    }
  }

  for (const [k, v] of Object.entries(overrides)) {
    if (k === "cwd") continue;
    if (v !== undefined) {
      (merged as Record<string, unknown>)[k] = v;
      if (!sources.includes("flags")) sources.push("flags");
    }
  }

  const region = merged.region ?? "prg1";
  return { ...merged, region, apiUrl: apiUrlForRegion(region), sources };
}

export function saveUserConfig(patch: StoredConfig): string {
  const existing = (readJsonish(USER_CONFIG) ?? {}) as StoredConfig;
  const next = { ...existing, ...patch };
  for (const key of Object.keys(next) as (keyof StoredConfig)[]) {
    if (next[key] === undefined) delete next[key];
  }
  mkdirSync(dirname(USER_CONFIG), { recursive: true });
  writeFileSync(USER_CONFIG, `${JSON.stringify(next, null, 2)}\n`);
  // The file holds a bearer token; keep it out of reach of other local users.
  chmodSync(USER_CONFIG, 0o600);
  return USER_CONFIG;
}

export const userConfigPath = USER_CONFIG;
