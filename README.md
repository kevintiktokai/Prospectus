# LayerSync Outreach

Agentic cold outreach system for LayerSync. Phase 1 lays the foundation: Next.js
14 dashboard skeleton, Supabase schema, and shared infrastructure that every
later phase (scrapers, enrichment, Claude drafts, Smartlead, replies) plugs
into.

First ICP: **UK recruitment agencies, 10–30 employees, owner-operated**.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Dashboard (Next.js)                    │
│   Overview · Companies · Contacts · Campaigns · Drafts ·    │
│   Sent · Replies · Activity Log                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Supabase (Postgres + Auth)                │
│                                                             │
│   companies ── contacts ── email_sequences ── campaigns     │
│        └───── signals ─────────┘                            │
│                  activity_log                               │
└─────────────────────────────────────────────────────────────┘
        ▲              ▲               ▲              ▲
        │              │               │              │
   Scrapers       Enrichment      Claude drafts   Smartlead
   (Phase 2)      (Phase 3-5)     (Phase 6-7)     (Phase 8)
```

Every scraper/enricher writes through `lib/logger.ts` so the Activity Log tab
shows what the system is doing in real time.

## Stack

- **Next.js 14** (App Router, TypeScript)
- **Supabase** (Postgres + Auth)
- **Tailwind** + **shadcn/ui**
- **Vercel** deploy target

## Setup

1. Install deps:

   ```bash
   npm install
   ```

2. Copy the env template and fill in values:

   ```bash
   cp .env.local.example .env.local
   ```

   Required for Phase 1:

   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

   The rest (`ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, `HUNTER_API_KEY`,
   `NEVERBOUNCE_API_KEY`, `SMARTLEAD_API_KEY`) are only needed once later
   phases are wired in.

3. Run the migration against a fresh Supabase project:

   ```bash
   supabase db push
   # or paste supabase/migrations/0001_initial_schema.sql into the SQL editor
   ```

4. Start the dev server:

   ```bash
   npm run dev
   ```

5. Verify:

   - http://localhost:3000/dashboard — Overview loads with all zeroes
   - http://localhost:3000/api/health — returns `{ ok: true, timestamp }`

## Project layout

```
app/
  api/health/route.ts        # DB connection health check
  dashboard/
    layout.tsx               # sidebar + shell
    page.tsx                 # Overview (counts + recent companies)
    companies/page.tsx       # stub
    contacts/page.tsx        # stub
    campaigns/page.tsx       # stub
    drafts/page.tsx          # stub
    sent/page.tsx            # stub
    replies/page.tsx         # stub
    activity/page.tsx        # stub
components/ui/               # shadcn primitives (Card, Table)
lib/
  supabase/server.ts         # service-role client (server only)
  supabase/client.ts         # anon client (browser)
  logger.ts                  # logActivity() → activity_log
  utils.ts                   # cn() helper
supabase/migrations/
  0001_initial_schema.sql    # companies, contacts, signals,
                             # campaigns, email_sequences, activity_log
types/database.ts            # typed row shapes for each table
```

## Phase roadmap

- **Phase 1 — Foundation** (this): schema, dashboard shell, logger, health check
- **Phase 2** — Scrapers (Google Places, Companies House, job boards)
- **Phase 3–5** — Enrichment (website scrape, Hunter, NeverBounce, scoring)
- **Phase 6–7** — Claude-drafted email sequences
- **Phase 8** — Smartlead send + reply sync
- **Phase 9+** — Reply classification, dashboards, auth

## Definition of done for Phase 1

- `npm run dev` starts the app
- `/dashboard` loads and shows all zeroes
- `/api/health` returns 200
- Migration runs cleanly on a fresh Supabase project
- The seed `UK Recruitment Agencies v1` campaign exists in `campaigns`
