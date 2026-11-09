import { useSession } from "@tanstack/react-start/server";

export type DiscordUser = { id: string; username: string; global_name: string | null; avatar: string | null };
export type AppSession = {
  user?: DiscordUser;
  accessToken?: string;
  admin?: boolean;
  oauthState?: string | undefined;
  lastAuthAt?: number;
  manageable?: string[];
};

export function getAppSession() {
  const password = process.env["SESSION_SECRET"];
  if (!password) throw new Error("SESSION_SECRET is not set");
  return useSession<AppSession>({
    password,
    name: "peak-session",
    maxAge: 60 * 60 * 24 * 7,
    // "none" so the session also works inside the editor preview frame.
    cookie: { httpOnly: true, secure: true, sameSite: "none", path: "/" },
  });
}
