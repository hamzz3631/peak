import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Endpoint the PEAK Python bot polls. Authenticated with the sync key shown in the admin panel.
async function verify(request: Request) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("bot_config").select("*").eq("id", 1).single();
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const h = (v: string) => createHash("sha256").update(v).digest();
  const ok = !!data && given.length > 0 && timingSafeEqual(h(given), h(data.sync_key));
  return ok ? { db: supabaseAdmin, cfg: data! } : null;
}

const statsSchema = z.object({
  servers: z.number().int().min(0).max(1e9),
  users: z.number().int().min(0).max(1e10),
  active_tickets: z.number().int().min(0).max(1e9),
  guild_ids: z.array(z.string().regex(/^\d+$/)).max(10000),
});

export const Route = createFileRoute("/api/public/bot/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const v = await verify(request);
        if (!v) return new Response("Unauthorized", { status: 401 });
        const since = new URL(request.url).searchParams.get("since");
        let q = v.db.from("guild_settings").select("guild_id,settings,updated_at");
        if (since) q = q.gt("updated_at", since);
        const { data } = await q;
        return Response.json({ token: v.cfg.bot_token, client_id: v.cfg.client_id, guilds: data ?? [], now: new Date().toISOString() });
      },
      POST: async ({ request }) => {
        const v = await verify(request);
        if (!v) return new Response("Unauthorized", { status: 401 });
        const parsed = statsSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return new Response("Bad request", { status: 400 });
        const now = new Date().toISOString();
        await v.db.from("bot_stats").update({ ...parsed.data, updated_at: now }).eq("id", 1);
        await v.db.from("bot_config").update({ last_bot_ping: now }).eq("id", 1);
        return Response.json({ ok: true });
      },
    },
  },
});
