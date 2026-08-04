import type { CommandSpec } from "../lib/spec.ts";
import { authCommands } from "./auth.ts";
import { projectCommands, projectEnvCommands } from "./project.ts";
import { serviceCommands } from "./service.ts";
import { envCommands } from "./env.ts";
import { deployCommands } from "./deploy.ts";
import { repoCommands, pipelineCommands } from "./repo.ts";
import { versionCommands } from "./version.ts";
import { logCommands } from "./logs.ts";
import { scaleCommands } from "./scale.ts";
import { backupCommands } from "./backup.ts";
import { routeCommands } from "./route.ts";
import { cdnCommands } from "./cdn.ts";
import { processCommands } from "./process.ts";
import { notificationCommands } from "./notification.ts";
import { tokenCommands } from "./token.ts";
import { miscCommands } from "./misc.ts";
import { apiCommands } from "./api.ts";
import { catalogCommands } from "./catalog.ts";
import { applyCommands } from "./apply.ts";

export const COMMANDS: CommandSpec[] = [
  ...authCommands,
  ...projectCommands,
  ...projectEnvCommands,
  ...applyCommands,
  ...serviceCommands,
  ...envCommands,
  ...deployCommands,
  ...repoCommands,
  ...pipelineCommands,
  ...versionCommands,
  ...logCommands,
  ...scaleCommands,
  ...backupCommands,
  ...routeCommands,
  ...cdnCommands,
  ...processCommands,
  ...notificationCommands,
  ...tokenCommands,
  ...miscCommands,
  ...apiCommands,
  ...catalogCommands,
];
