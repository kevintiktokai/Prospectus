# LayerSync Outreach — Build Progress

Phase-by-phase tracker. Tick items with `[x]` as they land. Each phase has a
quality gate at the bottom — do **not** start the next phase until that gate
passes. If it fails, diagnose and iterate.

---

## Phase 1 — Foundation
- [x] Next.js 14 App Router + TS + Tailwind + ESLint
- [x] Supabase migration 0001 (companies, contacts, signals, campaigns, email_sequences, activity_log)
- [x] Supabase clients (server + browser), typed via `types/database.ts`
- [x] Dashboard shell with sidebar + stub pages
- [x] `lib/logger.ts#logActivity`
- [x] `/api/health`
- [x] `UK Recruitment Agencies v1` campaign seeded

## Phase 2 — Google Places Scraper
- [x] `config/crawlers/uk-recruitment.ts`
- [x] `lib/scrapers/google-places.ts` (Places API New, pagination, backoff)
- [x] `lib/utils/domain.ts` (extract/normalize/social/job-board)
- [x] `lib/scrapers/company-writer.ts` (upsert by domain, filter heuristics)
- [x] `scripts/crawl-uk-recruitment.ts` orchestrator
- [x] Dashboard `/dashboard/companies` with filters + pagination
- [x] `source_counts` card on overview

## Phase 2.5 — Data Quality Audit
- [ ] Migration 0002: extend `enrichment_status` check to include `'skipped'`
- [ ] Extended junk-domain list (`.gov.uk` suffix + spec-named boards)
- [ ] `scripts/audit-phase-2.ts` (idempotent; reports only, writes no state)
- [ ] `scripts/apply-filter-pass.ts` (marks junk domains as `skipped`)
- [ ] `/dashboard/companies/audit` (counts by status + sample table)
- [ ] Audit output pasted below under "Phase 2 Audit"
- [ ] Filter pass run — number of records flipped to `skipped` recorded below

### Phase 2 Audit
<!-- Paste `npx tsx scripts/audit-phase-2.ts` output here after running -->
_Pending first run._

### Phase 2.5 Quality gate
Must have **≥ 250 companies** with `enrichment_status = 'pending'` after the
filter pass. If fewer, expand the Phase 2 crawl (add cities + specialist search
terms like `technical recruitment`, `finance recruitment`, `healthcare recruitment`)
before Phase 3.

---

## Phase 3 — Website Scraper & Enrichment
- [x] Playwright installed (Chromium download deferred — run `npx playwright install chromium` on local machine; the build sandbox blocks the download)
- [x] `lib/scrapers/website-scraper.ts` — Playwright, 15s timeout, sub-page discovery for /about · /team · /services · /what-we-do · /sectors, typed error result (timeout / navigation_failed / blocked / no_content / browser_failed)
- [x] `lib/enrichment/company-enricher.ts` — Claude Haiku 4.5 (`claude-haiku-4-5`) via `messages.parse` with a Zod schema; system prompt cached (`cache_control: ephemeral`); atomic claim transition (pending → enriching) so concurrent runners can't double-process
- [x] `scripts/enrich-companies.ts` — p-limit, configurable concurrency (default 5), `--limit N`, resumable
- [x] `/dashboard/companies/[id]` — overview, services, tech-stack signals, signals tab placeholder, error display
- [x] npm script: `enrich:companies`

To run locally:
```
npx playwright install chromium       # one-time, ~170MB
npm run enrich:companies -- --limit 20  # smoke test on 20 rows first
npm run enrich:companies                # full pending batch
```

Quality gate: ≥ 70% of the pending batch reaches `enriched`. Spot-check 10 —
descriptions must be specific, services must be real.

---

## Phase 4 — Signals Scraper
- [ ] `lib/scrapers/signals/blog-scraper.ts`
- [ ] `lib/scrapers/signals/careers-scraper.ts`
- [ ] `lib/scrapers/signals/news-scraper.ts` (Google News RSS, 1/3s)
- [ ] `lib/enrichment/signals-finder.ts`
- [ ] Migration 0003: `companies.last_signals_scan_at`
- [ ] `scripts/scan-signals.ts`
- [ ] "Signals" tab on company detail

Quality gate: ≥ 60% of enriched companies have ≥ 3 signals; signals are real.

---

## Phase 5 — Contact Discovery & Verification
- [ ] `lib/scrapers/team-page-scraper.ts` (Haiku extraction)
- [ ] `lib/enrichment/hunter-finder.ts`
- [ ] Decision-maker ranking + `is_primary_contact` selection
- [ ] Dedup across team_page + hunter sources
- [ ] `lib/enrichment/email-verifier.ts` (NeverBounce batch)
- [ ] `scripts/find-contacts.ts`
- [ ] `/dashboard/contacts` with filters

Quality gate: ≥ 40% of enriched companies have ≥ 1 primary contact with verified email.

---

## Phase 6 — Fit Scoring & Primary Signal
- [ ] `lib/scoring/company-scorer.ts`
- [ ] `scripts/score-companies.ts`
- [ ] Score column + filter on `/dashboard/companies`

Quality gate: Sensible distribution, ≥ 50 score 70+, top 10 pass manual review.

---

## Phase 7 — Email Drafting
- [ ] `lib/drafting/voice-samples.ts` (3 placeholder samples — replace with Kev's)
- [ ] `lib/drafting/email-drafter.ts` (Claude Sonnet, strict JSON, validators)
- [ ] `scripts/draft-emails.ts`
- [ ] `/dashboard/drafts` approval queue (Approve / Reject / Edit)

Quality gate: Taste-test 30 drafts. No more than 3 robotic. Kev must sign off.

---

## Phase 8 — Smartlead Integration
- [ ] `lib/integrations/smartlead.ts`
- [ ] `scripts/smartlead-init.ts` (one-time campaign + schedule setup)
- [ ] `lib/drafting/followup-drafter.ts` (steps 2, 3, 4)
- [ ] Approve-in-dashboard → push 4-step sequence to Smartlead
- [ ] `app/api/webhooks/smartlead/route.ts`
- [ ] `/dashboard/sent`

Quality gate: 1 test lead end-to-end, webhook verified.

### Pre-send safety (Kev owns)
- [ ] Dedicated sending domain (not layersyncai.com)
- [ ] SPF / DKIM / DMARC configured
- [ ] 2–3 weeks Smartlead inbox warmup complete

---

## Phase 9 — Reply Handling & Notifications
- [ ] `lib/drafting/reply-classifier.ts`
- [ ] `lib/drafting/reply-drafter.ts`
- [ ] `lib/notifications/telegram.ts`
- [ ] Telegram alerts for `interested` / `objection`
- [ ] Migration 0004: `followup_tasks` (for 14-day auto-reply re-engagement)
- [ ] `/dashboard/replies` grouped by classification

Quality gate: End-to-end manual test — reply from external account, classification
correct, draft in queue, Telegram fires.

---

## Phase 10 — Dashboard Polish & Pipeline
- [ ] Overview: stat cards, funnel chart, activity feed
- [ ] `/dashboard/pipeline` kanban
- [ ] `/dashboard/campaigns` editable
- [ ] `/dashboard/activity` paginated + filtered
- [ ] Mobile responsive
- [ ] Production deploy via Vercel

Quality gate: Kev answers any common question in < 60s of nav. No SQL needed.

---

## Blockers
<!-- When stuck, log here with: what was tried, what's blocking, what's needed to unblock. -->
_None._
