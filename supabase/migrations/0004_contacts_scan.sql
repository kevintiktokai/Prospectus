-- Phase 5 — contact scan tracking + dedupe.
--
-- last_contacts_scan_at lets the orchestrator skip companies already
-- processed. The partial unique index dedupes contacts on
-- (company_id, lower(first_name), lower(last_name)) so re-runs of
-- find-contacts.ts don't accumulate "Joe Smith / Joe Smith / Joe
-- Smith" rows when the team page is scraped twice.

alter table companies
  add column if not exists last_contacts_scan_at timestamptz;

create index if not exists idx_companies_contacts_scan_at
  on companies(last_contacts_scan_at);

create unique index if not exists idx_contacts_name_dedupe
  on contacts(company_id, lower(coalesce(first_name,'')), lower(coalesce(last_name,'')))
  where (first_name is not null or last_name is not null);
