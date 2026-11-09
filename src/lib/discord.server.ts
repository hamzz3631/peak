import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const DISCORD_API = "https://discord.com/api/v10";

/** Discord REST call that honours 429 Retry-After instead of hammering the API. */
export async function dfetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(`${DISCORD_API}${path}`, init);
  if (res.status === 429 && attempt < 3) {
    const body = (await res.clone().json().catch(() => ({}))) as { retry_after?: number };
    const wait = Math.min(Number(res.headers.get("retry-after") ?? body.retry_after ?? 1), 10);
    await new Promise((r) => setTimeout(r, wait * 1000 + 250));
    return dfetch(path, init, attempt + 1);
  }
  return res;
}

export async function getBotConfig() {
  const { data, error } = await supabaseAdmin.from("bot_config").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function botFetch(path: string, init: RequestInit = {}) {
  const cfg = await getBotConfig();
  if (!cfg.bot_token) throw new Error("Bot token is not configured yet. Open the admin panel to add it.");
  return dfetch(path, {
    ...init,
    headers: { Authorization: `Bot ${cfg.bot_token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export async function botGuildIds(): Promise<{ id: string; name: string; icon: string | null }[]> {
  const out: { id: string; name: string; icon: string | null }[] = [];
  let after = "0";
  for (let i = 0; i < 10; i++) {
    const res = await botFetch(`/users/@me/guilds?limit=200&after=${after}`);
    if (!res.ok) throw new Error(`Discord error ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as { id: string; name: string; icon: string | null }[];
    out.push(...page);
    if (page.length < 200) break;
    after = page[page.length - 1]!.id;
  }
  return out;
}

export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const sandboxHost = url.hostname === "localhost" ? request.headers.get("x-forwarded-host") : null;
  return sandboxHost ? `https://${sandboxHost}` : url.origin;
}
