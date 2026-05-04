// Per-company contact discovery orchestrator. Runs:
//   1. team-page scrape (Playwright + Haiku)
//   2. Hunter.io /domain-search
//   3. dedupe + rank + persist
//   4. NeverBounce verification on any newly-acquired emails
//
// The orchestrator is light — heavy lifting is in the four lib/ files
// it composes.

import Anthropic from "@anthropic-ai/sdk";

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import { scrapeTeamPage } from "@/lib/scrapers/team-page-scraper";
import { findEmailsForDomain } from "@/lib/enrichment/hunter-finder";
import {
  dedupeAndRank,
  persistContacts,
} from "@/lib/enrichment/contact-writer";
import { verifyContactsForCompany } from "@/lib/enrichment/email-verifier";
import type { Company } from "@/types/database";

export type FindContactsOutcome = {
  company_id: string;
  team: { ok: boolean; people: number; error?: string };
  hunter: { ok: boolean; emails: number; remaining: number | null; error?: string };
  persisted: { inserted: number; updated: number; primary_id: string | null };
  verified: { checked: number; valid: number; invalid: number; other: number };
};

export async function findContacts(
  company: Pick<Company, "id" | "name" | "website" | "domain">,
  options?: { skipVerify?: boolean; client?: Anthropic },
): Promise<FindContactsOutcome> {
  const outcome: FindContactsOutcome = {
    company_id: company.id,
    team: { ok: false, people: 0 },
    hunter: { ok: false, emails: 0, remaining: null },
    persisted: { inserted: 0, updated: 0, primary_id: null },
    verified: { checked: 0, valid: 0, invalid: 0, other: 0 },
  };

  // 1. Team page (best-effort — many sites don't have a real team page)
  let teamPeople: Awaited<ReturnType<typeof scrapeTeamPage>> = {
    ok: true,
    indexUrl: "",
    people: [],
    mailtoEmails: [],
  };
  if (company.website) {
    teamPeople = await scrapeTeamPage(company.website, options?.client);
    if (teamPeople.ok) {
      outcome.team = { ok: true, people: teamPeople.people.length };
    } else {
      outcome.team = { ok: false, people: 0, error: teamPeople.error };
    }
  } else {
    outcome.team = { ok: false, people: 0, error: "no_website" };
  }

  // 2. Hunter (only if we have a domain)
  let hunterEmails: Awaited<ReturnType<typeof findEmailsForDomain>> = {
    ok: true,
    domain: "",
    pattern: null,
    organization: null,
    emails: [],
    remainingCredits: null,
  };
  if (company.domain) {
    hunterEmails = await findEmailsForDomain(company.domain);
    if (hunterEmails.ok) {
      outcome.hunter = {
        ok: true,
        emails: hunterEmails.emails.length,
        remaining: hunterEmails.remainingCredits,
      };
    } else {
      outcome.hunter = {
        ok: false,
        emails: 0,
        remaining: hunterEmails.remainingCredits,
        error: hunterEmails.error,
      };
    }
  } else {
    outcome.hunter = { ok: false, emails: 0, remaining: null, error: "no_domain" };
  }

  // 3. Dedupe + rank + persist
  const candidates = dedupeAndRank(
    teamPeople.ok ? teamPeople.people : [],
    hunterEmails.ok ? hunterEmails.emails : [],
    teamPeople.ok ? teamPeople.mailtoEmails : [],
  );

  if (candidates.length > 0) {
    const persisted = await persistContacts(company.id, candidates);
    outcome.persisted = {
      inserted: persisted.inserted,
      updated: persisted.updated,
      primary_id: persisted.primaryContactId,
    };
  }

  // 4. Verify any unverified emails
  if (!options?.skipVerify) {
    try {
      outcome.verified = await verifyContactsForCompany(company.id);
    } catch (err) {
      await logActivity(
        "verify_emails_failed",
        "company",
        company.id,
        { domain: company.domain },
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Stamp the scan timestamp regardless of partial failure.
  const supabase = createServerClient();
  await supabase
    .from("companies")
    .update({ last_contacts_scan_at: new Date().toISOString() })
    .eq("id", company.id);

  await logActivity("contacts_scan_completed", "company", company.id, {
    domain: company.domain,
    team: outcome.team,
    hunter: outcome.hunter,
    persisted: outcome.persisted,
    verified: outcome.verified,
  });

  return outcome;
}
