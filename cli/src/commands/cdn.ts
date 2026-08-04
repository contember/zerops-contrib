/**
 * CDN, which is two separate features sharing a name.
 *
 *   static   the L7 balancer caching a routed domain. Enabled per route (`zz route http create
 *            --cdn`), purged per domain and path.
 *   storage  an object-storage bucket published through the CDN. Enabled on the service, purged
 *            by object path.
 *
 * They have distinct endpoints and neither purge affects the other, which is why the commands
 * are kept apart rather than folded into one `purge`.
 */
import type { CommandSpec } from "../lib/spec.ts";
import { settleProcess } from "../lib/process.ts";

export const cdnCommands: CommandSpec[] = [
  {
    path: ["cdn", "purge"],
    summary: "Invalidate the static CDN cache for a routed domain path.",
    args: [
      { name: "domain", description: "Domain whose cache should be purged.", required: true },
      { name: "path", description: "Path or pattern to invalidate, e.g. /* or /images/.", required: false },
    ],
    examples: ["zz cdn purge example.com '/*'", "zz cdn purge example.com /images/"],
    operations: ["PurgeStaticCdn"],
    async run(ctx, parsed) {
      const domain = parsed.args[0]!;
      const path = parsed.args[1] ?? "/*";
      const projectId = await ctx.projectId();
      if (ctx.dryRun) return { dryRun: true, operation: "PurgeStaticCdn", domain, path };
      const res = await ctx.api.call("PurgeStaticCdn", { path: { id: projectId, domain, path } });
      ctx.out.data(await settleProcess(ctx, res, `purging CDN cache for ${domain}${path}`));
    },
  },
  {
    path: ["cdn", "storage", "enable"],
    summary: "Publish an object-storage bucket through the CDN.",
    description: `Only object-storage services accept this. Once enabled, objects are served from the CDN edge
rather than directly from the bucket, so a changed object keeps serving its old body until
\`zz cdn storage purge\` runs.`,
    args: [{ name: "service", description: "Object-storage service hostname or id. Defaults to --service." }],
    examples: ["zz cdn storage enable assets"],
    operations: ["EnableStorageCdn"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      if (ctx.dryRun) return { dryRun: true, operation: "EnableStorageCdn", service: service.name };
      const res = await ctx.api.call("EnableStorageCdn", { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, res, `enabling storage CDN for ${service.name}`));
    },
  },
  {
    path: ["cdn", "storage", "disable"],
    summary: "Stop serving an object-storage bucket through the CDN.",
    destructive: true,
    args: [{ name: "service", description: "Object-storage service hostname or id. Defaults to --service." }],
    operations: ["DisableStorageCdn"],
    async run(ctx, parsed) {
      const service = await ctx.service(parsed.args[0]);
      await ctx.confirm(`disable the storage CDN for ${service.name}`);
      if (ctx.dryRun) return { dryRun: true, operation: "DisableStorageCdn", service: service.name };
      const res = await ctx.api.call("DisableStorageCdn", { path: { id: service.id } });
      ctx.out.data(await settleProcess(ctx, res, `disabling storage CDN for ${service.name}`));
    },
  },
  {
    path: ["cdn", "storage", "purge"],
    summary: "Invalidate cached objects of a storage bucket.",
    description: "Takes an object path inside the bucket, not a URL. Slashes are preserved, so a prefix purges everything under it.",
    args: [
      { name: "path", description: "Object path or prefix, e.g. images/ or '*'.", required: true },
      { name: "service", description: "Object-storage service hostname or id. Defaults to --service." },
    ],
    examples: ["zz cdn storage purge 'images/' assets", "zz cdn storage purge '*' assets"],
    operations: ["PurgeStorageCdn"],
    async run(ctx, parsed) {
      const path = parsed.args[0]!;
      const service = await ctx.service(parsed.args[1]);
      if (ctx.dryRun) return { dryRun: true, operation: "PurgeStorageCdn", service: service.name, path };
      await ctx.api.call("PurgeStorageCdn", { path: { id: service.id, path } });
      ctx.out.step(`purged ${path} from the ${service.name} CDN`);
      return { purged: true, service: service.name, path };
    },
  },
];
