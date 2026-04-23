-- Phase 2.5: allow companies.enrichment_status = 'skipped' so the audit
-- filter pass can quarantine junk domains (job boards, social URLs,
-- .gov.uk pages) without deleting them — we keep them for provenance.

alter table companies
  drop constraint if exists companies_enrichment_status_check;

alter table companies
  add constraint companies_enrichment_status_check
  check (enrichment_status in ('pending','enriching','enriched','failed','skipped'));
