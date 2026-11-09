# PEAK — Discord Bot & Dashboard

Website (TanStack Start + React + Tailwind) and Python bot (`/bot`, discord.py).

## Website
```sh
npm i
npm run dev
```
Set env vars from `.env.example` style: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`.

## Bot
See `bot/README.md`.

## Discord compliance
- Official bot API only, honours rate limits (429 Retry-After) with extra delays on bulk actions.
- OAuth scopes limited to `identify guilds`, `state` check, cooldown between authorize attempts.
- No mass pings from user content; DMs only opt-in.
- Never commit your bot token / client secret — they are stored in the admin panel, not in code.
