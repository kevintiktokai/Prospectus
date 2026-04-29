-- Phase 4 — signals scrape tracking + dedupe.
--
-- last_signals_scan_at lets the orchestrator skip companies scanned
-- recently. The partial unique index dedupes signals on (company_id,
-- type, url) when url is non-null — re-running scan-signals.ts won't
-- accumulate duplicates.

alter table companies
  add column if not exists last_signals_scan_at timestamptz;

create index if not exists idx_companies_signals_scan_at
  on companies(last_signals_scan_at);

create unique index if not exists idx_signals_dedupe
  on signals(company_id, type, url)
  where url is not null;
