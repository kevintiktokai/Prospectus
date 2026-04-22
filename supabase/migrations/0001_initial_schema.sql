-- LayerSync Outreach — initial schema
--
-- companies ── contacts ── email_sequences ── campaigns
--      └────── signals ──────┘
--              activity_log (append-only audit trail)

-- companies: the business entity
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text,
  domain text unique,
  country text,
  city text,
  industry text,
  sub_industry text,
  employee_estimate int,
  description text,
  services jsonb default '[]'::jsonb,
  tech_stack jsonb default '[]'::jsonb,
  source text not null,
  source_metadata jsonb default '{}'::jsonb,
  score int,
  discovered_at timestamptz default now(),
  last_enriched_at timestamptz,
  enrichment_status text default 'pending'
    check (enrichment_status in ('pending','enriching','enriched','failed')),
  enrichment_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_companies_domain on companies(domain);
create index idx_companies_status on companies(enrichment_status);
create index idx_companies_score on companies(score desc nulls last);

-- contacts: decision-makers
create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  first_name text,
  last_name text,
  full_name text generated always as
    (trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) stored,
  title text,
  seniority text,
  email text,
  email_verified boolean default false,
  email_verification_status text,
  email_verified_at timestamptz,
  linkedin_url text,
  source text not null,
  is_primary_contact boolean default false,
  score int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_contacts_company on contacts(company_id);
create index idx_contacts_email on contacts(email);
create unique index idx_contacts_email_unique on contacts(email)
  where email is not null;

-- signals: the "why now" evidence
create table signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  type text not null
    check (type in ('job_post','blog_post','news','funding',
                    'hiring_surge','leadership_change','tech_change',
                    'pain_mention','linkedin_post','press_release')),
  title text,
  content text,
  url text,
  detected_at timestamptz default now(),
  relevance_score numeric(3,2),
  is_primary boolean default false,
  created_at timestamptz default now()
);
create index idx_signals_company on signals(company_id);
create index idx_signals_primary on signals(company_id) where is_primary;

-- campaigns: outreach strategies
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icp_description text,
  value_prop text,
  target_country text,
  target_industry text,
  status text default 'active'
    check (status in ('draft','active','paused','completed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- email_sequences: outreach messages
create table email_sequences (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  signal_id uuid references signals(id),
  sequence_step int not null default 1,
  subject text,
  body text,
  status text default 'draft'
    check (status in ('draft','approved','queued','sent','opened',
                      'replied','bounced','unsubscribed','failed')),
  smartlead_id text,
  scheduled_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  reply_body text,
  reply_classification text
    check (reply_classification in ('interested','objection','not_now',
                                    'not_interested','ooo','auto_reply',null)),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_email_seq_contact on email_sequences(contact_id);
create index idx_email_seq_status on email_sequences(status);
create index idx_email_seq_smartlead on email_sequences(smartlead_id);

-- activity_log: everything the system does
create table activity_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb default '{}'::jsonb,
  status text default 'success' check (status in ('success','error','warning')),
  error_message text,
  created_at timestamptz default now()
);
create index idx_activity_created on activity_log(created_at desc);
create index idx_activity_entity on activity_log(entity_type, entity_id);

-- updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at_companies before update on companies
  for each row execute function update_updated_at();
create trigger set_updated_at_contacts before update on contacts
  for each row execute function update_updated_at();
create trigger set_updated_at_campaigns before update on campaigns
  for each row execute function update_updated_at();
create trigger set_updated_at_email_sequences before update on email_sequences
  for each row execute function update_updated_at();

-- seed the first campaign
insert into campaigns (name, icp_description, value_prop,
                       target_country, target_industry) values (
  'UK Recruitment Agencies v1',
  'UK-based independent recruitment agencies, 10-30 employees, owner-operated',
  'Custom AI agents that handle repetitive consultant work - CV screening, candidate outreach drafts, client reporting, LinkedIn sourcing - built once, no per-seat subscriptions.',
  'United Kingdom',
  'Recruitment'
);
