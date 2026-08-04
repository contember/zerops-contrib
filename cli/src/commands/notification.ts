/**
 * Platform notifications.
 *
 * The same feed as the bell in the GUI: finished and failed operations, container restarts,
 * quota and incident notices. Worth polling after an unattended deploy, because a failure that
 * happened *after* the process finished — an out-of-memory kill, a failing health check — shows
 * up here and nowhere in the process list.
 */
import type { CommandSpec } from "../lib/spec.ts";

interface Notification {
  id: string;
  type: string;
  actionName: string;
  created: string;
  serviceName?: string | null;
  serviceStackId?: string | null;
  projectId?: string | null;
  project?: { name?: string } | null;
  error?: unknown;
}

export const notificationCommands: CommandSpec[] = [
  {
    path: ["notification", "list"],
    summary: "List platform notifications for the organization.",
    description: `Newest first. Filter with --type ERROR to get just the failures, which is the useful form
after an unattended run.

Filtering by project or service is done server-side, so it is safe on a busy organization.`,
    flags: [
      { name: "limit", type: "number", default: 20, description: "How many notifications to return." },
      { name: "offset", type: "number", default: 0, description: "Skip this many, for paging." },
      { name: "type", type: "string", enum: ["SUCCESS", "WARNING", "ERROR"], description: "Only notifications of this severity." },
      { name: "for-project", type: "boolean", description: "Restrict to the selected project." },
      { name: "for-service", type: "string", placeholder: "<hostname|id>", description: "Restrict to one service." },
    ],
    examples: [
      "zops notification list --type ERROR",
      "zops notification list --for-project --limit 50 --json",
    ],
    operations: ["ListClientUserNotifications"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      const forService = ctx.flag<string>("for-service");
      const query: Record<string, unknown> = {
        limit: ctx.flag<number>("limit") ?? 20,
        offset: ctx.flag<number>("offset") ?? 0,
      };
      if (ctx.flag<string>("type")) query.types = ctx.flag<string>("type");
      if (ctx.bool("for-project")) query.projectId = await ctx.projectId();
      if (forService) query.serviceStackId = await ctx.serviceId(forService);

      const res = await ctx.api.call<{ list?: Notification[]; items?: Notification[]; totalCount?: number }>(
        "ListClientUserNotifications",
        { path: { id: clientId }, query },
      );
      const items = res.list ?? res.items ?? [];
      ctx.out.data(items, {
        columns: [
          { key: "type", header: "TYPE" },
          { key: "actionName", header: "ACTION" },
          { key: "serviceName", header: "SERVICE" },
          { key: "project", header: "PROJECT", get: (row: Notification) => row.project?.name ?? "-" },
          { key: "created", header: "CREATED" },
          { key: "id", header: "ID" },
        ],
        quietField: "id",
        emptyMessage: "no notifications",
      });
    },
  },
  {
    path: ["notification", "ack"],
    summary: "Acknowledge one notification.",
    args: [{ name: "notification-id", description: "Notification id (see `zops notification list`).", required: true }],
    operations: ["AcknowledgeUserNotification"],
    async run(ctx, parsed) {
      const id = parsed.args[0]!;
      if (ctx.dryRun) return { dryRun: true, operation: "AcknowledgeUserNotification", id };
      await ctx.api.call("AcknowledgeUserNotification", { path: { id } });
      ctx.out.step(`notification ${id} acknowledged`);
      return { acknowledged: true, id };
    },
  },
  {
    path: ["notification", "ack-all"],
    summary: "Acknowledge every outstanding notification.",
    description: "Scope it with --for-project or --for-service; without either, the whole organization is cleared.",
    destructive: true,
    flags: [
      { name: "for-project", type: "boolean", description: "Only notifications of the selected project." },
      { name: "for-service", type: "string", placeholder: "<hostname|id>", description: "Only notifications of one service." },
    ],
    examples: ["zops notification ack-all --for-project --yes"],
    operations: ["AcknowledgeAllUserNotifications"],
    async run(ctx) {
      const clientId = await ctx.clientId();
      const forService = ctx.flag<string>("for-service");
      const body: Record<string, unknown> = { clientId };
      if (ctx.bool("for-project")) body.projectId = await ctx.projectId();
      if (forService) body.serviceStackId = await ctx.serviceId(forService);

      const scope = body.serviceStackId
        ? `service ${forService}`
        : body.projectId
          ? `project ${(await ctx.project()).name}`
          : "the whole organization";
      await ctx.confirm(`acknowledge every notification for ${scope}`);
      if (ctx.dryRun) return { dryRun: true, operation: "AcknowledgeAllUserNotifications", body };
      await ctx.api.call("AcknowledgeAllUserNotifications", { body });
      ctx.out.step(`notifications acknowledged for ${scope}`);
      return { acknowledged: true, scope };
    },
  },
];
