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
- [x] `lib/scrapers/_browser.ts` — shared headless Chromium pool
- [x] `lib/scrapers/signals/blog-scraper.ts` — finds /blog · /news · /insights · /resources, extracts up to 5 posts via anchor + nearest-heading heuristics
- [x] `lib/scrapers/signals/careers-scraper.ts` — same-origin /careers + ATS hosts (Workable, Greenhouse, Lever, Bullhorn, Workday); role-keyword filter
- [x] `lib/scrapers/signals/news-scraper.ts` — Google News RSS, plain-fetch + tiny inline RSS parser (no third-party dep)
- [x] `lib/enrichment/signals-finder.ts` — orchestrator: blog + careers in parallel, news serialised; persists via upsert with `onConflict: 'company_id,type,url'`
- [x] Migration 0003: `companies.last_signals_scan_at` + partial unique index `idx_signals_dedupe(company_id, type, url) where url is not null`
- [x] `scripts/scan-signals.ts` — `--limit`, `--concurrency` (default 3), `--rescan`; global news throttle (1/3s)
- [x] Signals tab already on `/dashboard/companies/[id]` — populates automatically once rows exist

Run locally:
```
npm run scan:signals -- --limit 20      # smoke test
npm run scan:signals                    # full enriched batch
```

Quality gate: ≥ 60% of enriched companies have ≥ 3 signals; signals are real.

---

## Phase 5 — Contact Discovery & Verification
- [x] `lib/scrapers/team-page-scraper.ts` — Playwright fetches /team · /people · /leadership · /about; Haiku extracts `[{first_name, last_name, title, email?}]`; mailto: anchors captured separately for name-based association
- [x] `lib/enrichment/hunter-finder.ts` — `/v2/domain-search` with `seniority=executive,senior` filter; reads `x-credits-remaining` header
- [x] `lib/enrichment/contact-writer.ts` — title-keyword seniority ranking (Founder > MD/CEO > C-suite > Director/Partner > Head of > Senior Mgr > Manager > Lead > Senior > IC); two-pass dedupe (email then lower-cased name); team_page wins on name/title, Hunter wins on email; sets `is_primary_contact` to highest-ranked row that has an email
- [x] `lib/enrichment/email-verifier.ts` — NeverBounce single-check; only `result === "valid"` sets `email_verified = true` (catch-alls + unknown stay unverified)
- [x] `lib/enrichment/contact-finder.ts` — orchestrator
- [x] Migration 0004: `companies.last_contacts_scan_at` + partial unique index `idx_contacts_name_dedupe(company_id, lower(first_name), lower(last_name))`
- [x] `scripts/find-contacts.ts` — `--limit`, `--concurrency` (default 2), `--rescan`, `--skip-verify`
- [x] `/dashboard/contacts` — filter by verified/primary, search across name/email/title, paginated 50/page

Run locally:
```
npm run find:contacts -- --limit 5 --skip-verify   # smallest smoke (1 Hunter call/co)
npm run find:contacts                              # full enriched batch
```

Quality gate: ≥ 40% of enriched companies have ≥ 1 primary contact with
verified email. Hunter credits remaining are reported in BUILD_PROGRESS
after each run if low.

---

## Phase 6 — Fit Scoring & Primary Signal
- [x] `lib/scoring/company-scorer.ts` — Claude Haiku 4.5 (`messages.parse` + Zod). System prompt encodes the LayerSync ICP (10–30 staff, owner-operated, no AI-recruitment competitors), hard penalties for competitor self-positioning, and rubric for the 0–100 score. System prompt cached.
- [x] Defensive validation: hallucinated `primary_signal_id` UUIDs are silently dropped (allowed-set check against the actual signals sent).
- [x] Persists `companies.score` and flips `signals.is_primary` on the chosen signal (resetting any previous primary first).
- [x] `scripts/score-companies.ts` — `--limit`, `--concurrency` (default 5), `--rescore`, `--campaign <id>`. Prints score distribution buckets so you see whether it's a sensible bell curve.
- [x] `/dashboard/companies` — default sort is now `score desc · discovered_at desc`; `?sort=recent` flips to discovered-only. Min-score numeric input + one-click "Score ≥ 70" pill.

Run locally:
```
npm run score:companies -- --limit 30   # smoke test the rubric on 30 first
npm run score:companies                 # full enriched batch
```

Quality gate: Sensible distribution, ≥ 50 score 70+, top 10 pass manual review.

---

## Phase 7 — Email Drafting
- [x] `lib/drafting/voice-samples.ts` — 3 PLACEHOLDER samples (resourcer roles, reporting ops, Bullhorn export problem). **Replace with your real cold emails before the gate review** — bad samples in = robotic output.
- [x] `lib/drafting/email-drafter.ts` — Claude Sonnet 4.6 via `messages.parse` + Zod. System prompt encodes cold-email principles + voice samples + anti-patterns (forbidden phrase regex list); cached.
- [x] Validation: subject ≤ 6 words, lowercase, no `?` / `!`; body ≤ 90 words, contains `Hi {firstName},` and `Kev` sign-off; no forbidden phrases. On fail, retry once with the validation errors fed back to the model. Hard fail on second attempt → row marked `failed`, activity logged.
- [x] `scripts/draft-emails.ts` — `--limit`, `--min-score` (default 70), `--concurrency` (default 3), `--campaign <id>`. Idempotent via `alreadyHasDraft` guard.
- [x] `/dashboard/drafts` — tab nav (draft / approved / failed) with counts. Per-card: company + contact + signal hook + subject + body. Three actions wired to server actions: **Approve** (sets `status='approved'`), **Edit** (inline subject + textarea form), **Reject** (with optional reason → `failed` + activity log).
- [x] `email_sequences.Insert` tightened to `Pick<contact_id|campaign_id> & Partial<rest>`.

Run locally:
```
npm run draft:emails -- --limit 10   # smoke first
npm run draft:emails                 # full eligible batch
```

Quality gate: Generate 30 drafts. Read all of them at `/dashboard/drafts`.
Ask: would Kev send this exact email? **No more than 3 robotic.** If more,
iterate on `lib/drafting/voice-samples.ts` (or the SYSTEM_PROMPT) before
moving on. Note any prompt iterations under **Blockers** below.

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

---

## Running the pipeline without a laptop (GitHub Actions)

Manual-only triggers — no schedules. Click **Run workflow** in the GH UI when
you want to fire one. Each stage is idempotent so re-running picks up where it
left off.

### One-time setup: paste secrets

Go to `https://github.com/kevintiktokai/Prospectus/settings/secrets/actions`
and add:

| Secret | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | every workflow |
| `SUPABASE_SERVICE_ROLE_KEY` | every workflow |
| `ANTHROPIC_API_KEY` | enrich, contacts, score, draft, pipeline |
| `GOOGLE_PLACES_API_KEY` | crawl |
| `HUNTER_API_KEY` | contacts, pipeline |
| `NEVERBOUNCE_API_KEY` | contacts, pipeline |

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is not needed — the workflows use the service
role key only.

### The workflows

Each lives at `.github/workflows/*.yml`. Trigger from the **Actions** tab.

| Workflow | What it does | Useful inputs |
|---|---|---|
| `phase-2 · crawl UK recruitment` | Google Places crawl. Run sparingly — re-running costs API calls but won't dupe rows (domain unique index). | `note` |
| `phase-2.5 · audit + filter` | Read-only audit, dry-run filter, or apply filter | `mode` (audit / filter / filter-dry-run) |
| `phase-3 · enrich companies` | Playwright + Haiku 4.5 enrichment | `limit`, `concurrency` |
| `phase-4 · scan signals` | Blog + careers + Google News | `limit`, `concurrency`, `rescan` |
| `phase-5 · find contacts` | Team-page + Hunter + NeverBounce. Default `limit=25` to bound Hunter spend. | `limit`, `concurrency`, `skip_verify`, `rescan` |
| `phase-6 · score companies` | Haiku 4.5 fit scoring | `limit`, `concurrency`, `rescore` |
| `phase-7 · draft emails` | Sonnet 4.6 drafts (read at `/dashboard/drafts`) | `limit`, `min_score`, `concurrency` |
| `pipeline · enrich → … → draft` | Chained smoke run. Per-stage `\|\| true` so a single failure doesn't block downstream stages. | `limit`, `skip_contacts` |

All workflows share `concurrency.group: pipeline-mutating` so two stages can't
run at once and clash on the database.

### Recommended first run

Pick a small `limit` and watch the logs:
1. `phase-2.5 · audit + filter` → mode: `audit` (sanity check)
2. `phase-2.5 · audit + filter` → mode: `filter-dry-run` (see how many would flip)
3. `phase-2.5 · audit + filter` → mode: `filter` (commit it)
4. `phase-3 · enrich companies` → `limit: 10` (smoke)
5. `phase-3 · enrich companies` → blank (full batch)
6. ...and so on

Or skip to `pipeline · enrich → … → draft` with `limit: 10` and `skip_contacts: true`
to smoke the whole chain end-to-end without burning Hunter credits.

### What still requires your intervention

- **Approving drafts at `/dashboard/drafts`** — phase-7 stops at "draft" status.
  Approve / Edit / Reject is a human action. (Phase 8 will push approved drafts
  to Smartlead — that's also human-triggered.)
- **Replacing the placeholder voice samples** in `lib/drafting/voice-samples.ts`
  with your real cold emails before the gate review on phase-7.
- **Supabase migrations** — paste each new `supabase/migrations/000N_*.sql`
  file into the Supabase SQL editor when it lands.
