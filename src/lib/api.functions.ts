import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { botFetch, botGuildIds, dfetch, getBotConfig, requestOrigin } from "./discord.server";
import { getAppSession } from "./session.server";
import { ADMIN_DISCORD_ID, deepMerge, defaultSettings } from "./settings";

const snowflake = z.string().regex(/^\d{5,25}$/);
const ADMIN_PERM = 0x8n;
// Permissions the bot asks for when invited (admin keeps setup simple for welcome, tickets, protection, logs).
const INVITE_PERMS = "8";

function safeEq(a: string, b: string) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function requireAdmin() {
  const s = await getAppSession();
  if (!s.data.admin) throw new Error("Forbidden");
  return s;
}

async function requireGuildAccess(guildId: string) {
  const s = await getAppSession();
  if (s.data.admin) return s;
  if (!s.data.user) throw new Error("Please sign in with Discord first.");
  if (!s.data.manageable?.includes(guildId)) throw new Error("You need Administrator permission in this server.");
  return s;
}

// ---------- session ----------
export const getSessionInfo = createServerFn({ method: "GET" }).handler(async () => {
  const s = await getAppSession();
  const cfg = await getBotConfig();
  return {
    user: s.data.user ?? null,
    admin: !!s.data.admin,
    botReady: !!(cfg.client_id && cfg.bot_token),
    clientId: cfg.client_id ?? null,
  };
});

export const adminLogin = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; password: string }) => z.object({ id: z.string().max(40), password: z.string().max(200) }).parse(d))
  .handler(async ({ data }) => {
    const expected = process.env["ADMIN_PASSWORD"];
    if (!expected) throw new Error("ADMIN_PASSWORD is not set");
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    const ok = safeEq(data.id.trim(), ADMIN_DISCORD_ID) && safeEq(data.password, expected);
    if (!ok) return { ok: false as const };
    const s = await getAppSession();
    await s.update({ admin: true });
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const s = await getAppSession();
  await s.clear();
  return { ok: true };
});

// ---------- public ----------
export const getPublicStats = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data } = await db.from("bot_stats").select("servers,users,active_tickets").eq("id", 1).single();
  const cfg = await getBotConfig();
  return {
    servers: data?.servers ?? 0,
    users: data?.users ?? 0,
    tickets: data?.active_tickets ?? 0,
    inviteUrl: cfg.client_id
      ? `https://discord.com/oauth2/authorize?client_id=${cfg.client_id}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`
      : null,
  };
});

// ---------- user dashboard ----------
export const listMyGuilds = createServerFn({ method: "GET" }).handler(async () => {
  const s = await getAppSession();
  if (!s.data.user || !s.data.accessToken) return { signedIn: false as const, guilds: [] };
  const res = await dfetch("/users/@me/guilds", { headers: { Authorization: `Bearer ${s.data.accessToken}` } });
  if (res.status === 401) {
    await s.clear();
    return { signedIn: false as const, guilds: [] };
  }
  if (!res.ok) throw new Error(`Discord error ${res.status}`);
  const all = (await res.json()) as { id: string; name: string; icon: string | null; owner: boolean; permissions: string }[];
  const mine = all.filter((g) => g.owner || (BigInt(g.permissions) & ADMIN_PERM) === ADMIN_PERM);
  let botIds = new Set<string>();
  try {
    botIds = new Set((await botGuildIds()).map((g) => g.id));
  } catch {
    /* bot not configured yet */
  }
  await s.update({ manageable: mine.map((g) => g.id) });
  const cfg = await getBotConfig();
  return {
    signedIn: true as const,
    guilds: mine
      .map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        botIn: botIds.has(g.id),
        inviteUrl: cfg.client_id
          ? `https://discord.com/oauth2/authorize?client_id=${cfg.client_id}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands&guild_id=${g.id}&disable_guild_select=true`
          : null,
      }))
      .sort((a, b) => Number(b.botIn) - Number(a.botIn)),
  };
});

type Channel = { id: string; name: string; type: number; parent_id: string | null; position: number };
type Role = { id: string; name: string; color: number; position: number; managed: boolean };

export const getGuildData = createServerFn({ method: "GET" })
  .inputValidator((d: { guildId: string }) => z.object({ guildId: snowflake }).parse(d))
  .handler(async ({ data }) => {
    await requireGuildAccess(data.guildId);
    const g = await botFetch(`/guilds/${data.guildId}?with_counts=true`);
    if (g.status === 403 || g.status === 404) return { botMissing: true as const };
    if (!g.ok) throw new Error(`Discord error ${g.status}: ${await g.text()}`);
    const guild = (await g.json()) as { id: string; name: string; icon: string | null; approximate_member_count?: number };
    const [chRes, roleRes] = await Promise.all([botFetch(`/guilds/${data.guildId}/channels`), botFetch(`/guilds/${data.guildId}/roles`)]);
    const channels = ((await chRes.json()) as Channel[]).sort((a, b) => a.position - b.position);
    const roles = ((await roleRes.json()) as Role[]).filter((r) => r.name !== "@everyone").sort((a, b) => b.position - a.position);
    const db = await admin();
    const { data: row } = await db.from("guild_settings").select("settings").eq("guild_id", data.guildId).maybeSingle();
    return {
      botMissing: false as const,
      guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.approximate_member_count ?? 0 },
      channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id })),
      roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color, managed: r.managed })),
      settings: deepMerge(defaultSettings(), row?.settings ?? {}),
    };
  });

export const saveGuildSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { guildId: string; settings: unknown }) =>
    z.object({ guildId: snowflake, settings: z.record(z.string(), z.unknown()) }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireGuildAccess(data.guildId);
    if (JSON.stringify(data.settings).length > 200_000) throw new Error("Settings are too large.");
    const db = await admin();
    const { error } = await db
      .from("guild_settings")
      .upsert({ guild_id: data.guildId, settings: data.settings as never, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    // Apply the bot nickname right away (rate-limit safe single call).
    const nick = (data.settings as { general?: { nickname?: string } }).general?.nickname;
    if (typeof nick === "string") {
      await botFetch(`/guilds/${data.guildId}/members/@me`, { method: "PATCH", body: JSON.stringify({ nick: nick || null }) }).catch(() => null);
    }
    return { ok: true };
  });

const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  color: z.number().int().optional(),
  image: z.object({ url: z.string().url() }).optional(),
  thumbnail: z.object({ url: z.string().url() }).optional(),
  footer: z.object({ text: z.string().max(2048) }).optional(),
  author: z.object({ name: z.string().max(256) }).optional(),
});

export const sendToChannel = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        guildId: snowflake,
        channelId: snowflake,
        content: z.string().max(2000).optional(),
        embeds: z.array(embedSchema).max(10).optional(),
        components: z.array(z.any()).max(5).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireGuildAccess(data.guildId);
    const ch = await botFetch(`/channels/${data.channelId}`);
    const chJson = (await ch.json()) as { guild_id?: string };
    if (!ch.ok || chJson.guild_id !== data.guildId) throw new Error("That channel is not in this server.");
    const res = await botFetch(`/channels/${data.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: data.content, embeds: data.embeds, components: data.components, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord refused the message (${res.status}): ${await res.text()}`);
    return { ok: true };
  });

// ---------- admin ----------
export const getBotCredentials = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const cfg = await getBotConfig();
  const req = getRequest();
  let botUser: { id: string; username: string; avatar: string | null } | null = null;
  if (cfg.bot_token) {
    const r = await botFetch("/users/@me").catch(() => null);
    if (r?.ok) botUser = await r.json();
  }
  const db = await admin();
  const { data: stats } = await db.from("bot_stats").select("*").eq("id", 1).single();
  const origin = req ? requestOrigin(req) : "";
  return {
    clientId: cfg.client_id ?? "",
    clientSecret: cfg.client_secret ?? "",
    botToken: cfg.bot_token ?? "",
    syncKey: cfg.sync_key,
    lastPing: cfg.last_bot_ping,
    botUser,
    stats,
    redirectUri: `${origin}/api/auth/discord/callback`,
    siteUrl: origin,
  };
});

export const saveBotCredentials = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ clientId: z.string().max(30), clientSecret: z.string().max(200), botToken: z.string().max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireAdmin();
    const db = await admin();
    const { error } = await db
      .from("bot_config")
      .update({ client_id: data.clientId.trim() || null, client_secret: data.clientSecret.trim() || null, bot_token: data.botToken.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const regenerateSyncKey = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin();
  const db = await admin();
  await db.from("bot_config").update({ sync_key: randomBytes(24).toString("hex") }).eq("id", 1);
  return { ok: true };
});

export const adminListBotGuilds = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  try {
    return { guilds: await botGuildIds(), error: null };
  } catch (e) {
    return { guilds: [], error: (e as Error).message };
  }
});
