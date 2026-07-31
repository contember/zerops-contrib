import type { CommandSpec } from "../lib/spec.ts";
import { authCommands } from "./auth.ts";
import { projectCommands, projectEnvCommands } from "./project.ts";
import { serviceCommands } from "./service.ts";
import { envCommands } from "./env.ts";
import { deployCommands } from "./deploy.ts";
import { versionCommands } from "./version.ts";
import { logCommands } from "./logs.ts";
import { scaleCommands } from "./scale.ts";
import { backupCommands } from "./backup.ts";
import { routeCommands } from "./route.ts";
import { processCommands } from "./process.ts";
import { miscCommands } from "./misc.ts";
import { apiCommands } from "./api.ts";
import { catalogCommands } from "./catalog.ts";

export const COMMANDS: CommandSpec[] = [
  ...authCommands,
  ...projectCommands,
  ...projectEnvCommands,
  ...serviceCommands,
  ...envCommands,
  ...deployCommands,
  ...versionCommands,
  ...logCommands,
  ...scaleCommands,
  ...backupCommands,
  ...routeCommands,
  ...processCommands,
  ...miscCommands,
  ...apiCommands,
  ...catalogCommands,
];
