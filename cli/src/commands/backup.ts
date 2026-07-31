/**
 * Backups.
 *
 * The whole group is reachable over the API, including tagging on creation — which means a
 * protected backup can be taken headlessly, contrary to what the container-side `zsc
 * backup-create` allows.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { notFound, usage } from "../lib/errors.ts";

interface BackupFile {
  path: string;
  name: string;
  size: number;
  metadata: Record<string, unknown>;
}

interface BackupList {
  files: BackupFile[];
  backupPeriod: string;
  retentionPolicy?: Record<string, unknown>;
  defaultRetentionPolicy?: Record<string, unknown>;
}

const humanSize = (bytes: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

async function fetchBackups(
  ctx: import("../lib/context.ts").Context,
  serviceId: string,
): Promise<BackupList> {
  return ctx.api.call<BackupList>("ListBackups", { path: { id: serviceId } });
}

export const backupCommands: CommandSpec[] = [
  {
    path: ["backup", "list"],
    summary: "List a service's backups.",
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    examples: ["zz backup list db", "zz backup list db --json"],
    operations: ["ListBackups"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const res = await fetchBackups(ctx, service.id);
      ctx.out.info(`backup period: ${res.backupPeriod}`);
      ctx.out.data(res.files ?? [], {
        columns: [
          { key: "name", header: "NAME" },
          { key: "size", header: "SIZE", get: (row: BackupFile) => humanSize(row.size) },
          { key: "tags", header: "TAGS", get: (row: BackupFile) => row.metadata?.tags ?? "-" },
          { key: "mode", header: "MODE", get: (row: BackupFile) => row.metadata?.mode ?? "-" },
        ],
        quietField: "name",
        emptyMessage: "no backups",
      });
    },
  },
  {
    path: ["backup", "create"],
    summary: "Trigger a backup now.",
    description: `Tags can be set at creation time, so a protected backup can be taken from CI. The API
returns as soon as the backup is triggered; \`async: true\` means it took longer than ten
seconds and is still running in the background.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [{ name: "tag", type: "string[]", placeholder: "<tag>", description: "Tag to attach. Repeatable. Protected tags are exempt from retention pruning." }],
    examples: ["zz backup create db", "zz backup create db --tag pre-migration --tag protected"],
    operations: ["BackupServiceStack"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const tags = ctx.flag<string[]>("tag") ?? [];
      if (ctx.dryRun) return { dryRun: true, operation: "BackupServiceStack", service: service.name, tags };
      const res = await ctx.api.call<{ success: boolean; async: boolean }>("BackupServiceStack", {
        path: { id: service.id },
        body: tags.length > 0 ? { tags } : {},
      });
      ctx.out.step(res.async ? `backup of ${service.name} running in the background` : `backup of ${service.name} finished`);
      ctx.out.data({ ...res, service: service.name, tags });
    },
  },
  {
    path: ["backup", "tag"],
    summary: "Replace the tags on an existing backup.",
    args: [
      { name: "date", description: "Backup name, i.e. its date (see `zz backup list`).", required: true },
      { name: "service", description: "Service hostname or id. Defaults to --service." },
    ],
    flags: [{ name: "tag", type: "string[]", placeholder: "<tag>", description: "Tag to set. Repeatable. Passing none clears all tags." }],
    examples: ['zz backup tag "2026-07-01 09:00:06" db --tag protected'],
    operations: ["UpdateBackup"],
    async run(ctx, parsed) {
      const date = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      const tags = ctx.flag<string[]>("tag") ?? [];
      if (ctx.dryRun) return { dryRun: true, operation: "UpdateBackup", date, tags };
      await ctx.api.call("UpdateBackup", { path: { id: service.id, date }, body: { tags } });
      ctx.out.step(`tags on ${date} set to ${tags.length ? tags.join(", ") : "(none)"}`);
      ctx.out.data({ date, tags, service: service.name });
    },
  },
  {
    path: ["backup", "download-url"],
    summary: "Create a temporary download URL for a backup.",
    args: [
      { name: "date", description: "Backup name, i.e. its date (see `zz backup list`).", required: true },
      { name: "service", description: "Service hostname or id. Defaults to --service." },
    ],
    examples: ['curl -o dump.tar.gz "$(zz backup download-url "2026-07-01 09:00:06" db -q)"'],
    operations: ["CreateDownloadBackupUrl"],
    async run(ctx, parsed) {
      const date = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      if (ctx.dryRun) return { dryRun: true, operation: "CreateDownloadBackupUrl", date };
      const res = await ctx.api.call<{ url?: string; downloadUrl?: string }>("CreateDownloadBackupUrl", {
        path: { id: service.id, date },
      });
      const url = res.url ?? res.downloadUrl;
      if (!url) throw notFound(`no download URL returned for backup ${date}`);
      if (ctx.out.json) {
        ctx.out.data(res);
        return;
      }
      ctx.out.raw(url);
    },
  },
  {
    path: ["backup", "delete"],
    summary: "Delete a backup.",
    destructive: true,
    args: [
      { name: "date", description: "Backup name, i.e. its date (see `zz backup list`).", required: true },
      { name: "service", description: "Service hostname or id. Defaults to --service." },
    ],
    operations: ["DeleteBackup"],
    async run(ctx, parsed) {
      const date = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      await ctx.confirm(`delete backup ${date} of ${service.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DeleteBackup", date };
      await ctx.api.call("DeleteBackup", { path: { id: service.id, date } });
      ctx.out.step(`backup ${date} deleted`);
      ctx.out.data({ deleted: true, date, service: service.name });
    },
  },
  {
    path: ["backup", "config"],
    summary: "Show or change the backup schedule and retention policy.",
    description: `With no flags, prints the current configuration. Retention flags all take effect together,
so the command reads the existing policy and merges your changes into it.`,
    args: [{ name: "service", description: "Service hostname or id. Defaults to --service." }],
    flags: [
      { name: "period", type: "string", placeholder: "<cron|period>", description: "Backup period, e.g. daily." },
      { name: "max-total-files", type: "number", description: "Maximum number of backup files to keep." },
      { name: "max-total-gib", type: "number", description: "Maximum combined size in GiB." },
      { name: "min-daily", type: "number", description: "Minimum daily backups to keep." },
      { name: "max-daily", type: "number", description: "Maximum daily backups to keep." },
      { name: "min-weekly", type: "number", description: "Minimum weekly backups to keep." },
      { name: "max-weekly", type: "number", description: "Maximum weekly backups to keep." },
      { name: "min-monthly", type: "number", description: "Minimum monthly backups to keep." },
      { name: "max-monthly", type: "number", description: "Maximum monthly backups to keep." },
      { name: "protected-tag", type: "string[]", placeholder: "<tag>", description: "Tag exempt from automatic deletion. Repeatable; replaces the existing set." },
    ],
    examples: ["zz backup config db", "zz backup config db --period daily --max-total-files 30"],
    operations: ["ListBackups", "ConfigureBackup"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      const current = await fetchBackups(ctx, service.id);

      const fields: Record<string, string> = {
        "max-total-files": "maxTotalFiles",
        "max-total-gib": "maxTotalGiB",
        "min-daily": "minDaily",
        "max-daily": "maxDaily",
        "min-weekly": "minWeekly",
        "max-weekly": "maxWeekly",
        "min-monthly": "minMonthly",
        "max-monthly": "maxMonthly",
      };
      const touched = [...Object.keys(fields), "period", "protected-tag"].filter(
        (f) => ctx.flags[f] !== undefined,
      );

      if (touched.length === 0) {
        ctx.out.data({
          service: service.name,
          backupPeriod: current.backupPeriod,
          retentionPolicy: current.retentionPolicy ?? current.defaultRetentionPolicy ?? null,
        });
        return;
      }

      const base = (current.retentionPolicy ?? current.defaultRetentionPolicy ?? {}) as Record<string, unknown>;
      const retentionPolicy: Record<string, unknown> = { ...base };
      for (const [flag, key] of Object.entries(fields)) {
        const value = ctx.flag<number>(flag);
        if (value !== undefined) retentionPolicy[key] = value;
      }
      const protectedTags = ctx.flag<string[]>("protected-tag");
      if (protectedTags) retentionPolicy.protectedTags = protectedTags;

      // The endpoint requires the whole policy; a field missing from the merge would be rejected.
      const required = [
        "maxTotalFiles", "maxTotalGiB", "protectedTags",
        "minDaily", "maxDaily", "minWeekly", "maxWeekly", "minMonthly", "maxMonthly",
      ];
      const missing = required.filter((k) => retentionPolicy[k] === undefined);
      if (missing.length > 0) {
        throw usage(
          `retention policy is incomplete: ${missing.join(", ")} have no current value`,
          `Supply them explicitly: ${missing.map((m) => `--${m.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(" ")}`,
        );
      }

      const body = {
        ...(ctx.flag<string>("period") ? { backupPeriod: ctx.flag<string>("period") } : {}),
        retentionPolicy,
      };

      if (ctx.dryRun) return { dryRun: true, operation: "ConfigureBackup", service: service.name, body };
      await ctx.api.call("ConfigureBackup", { path: { id: service.id }, body });
      ctx.out.step(`backup configuration updated for ${service.name}`);
      ctx.out.data({ service: service.name, ...body });
    },
  },
];
