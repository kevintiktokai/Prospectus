// Contact writer: takes extracted people from team-page + Hunter,
// dedupes them, ranks by seniority, marks one is_primary_contact per
// company, and persists to Supabase.
//
// Dedupe strategy (in order):
//   1. exact email match (case-insensitive)
//   2. exact (first_name, last_name) match (lowered)
// Prefer team_page for name/title (more authentic), Hunter for email.

import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import type { ExtractedPerson } from "@/lib/scrapers/team-page-scraper";
import type { HunterEmail } from "@/lib/enrichment/hunter-finder";

type Source = "team_page" | "hunter";

type CandidateContact = {
  source: Source;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  hunterConfidence: number | null;
  hunterSeniority: string | null;
};

// Title -> seniority bucket. Matched left-to-right; first match wins.
const SENIORITY_RULES: Array<{
  rank: number;
  seniority: string;
  pattern: RegExp;
}> = [
  { rank: 100, seniority: "founder", pattern: /\b(founder|co-?founder|owner|principal)\b/i },
  { rank: 95, seniority: "ceo", pattern: /\b(c\.?e\.?o\.?|chief executive|managing director|md)\b/i },
  { rank: 90, seniority: "c_suite", pattern: /\b(c\.?[a-z]\.?o\.?|chief\s+\w+\s+officer)\b/i },
  { rank: 85, seniority: "director", pattern: /\b(director|partner|vice president|vp)\b/i },
  { rank: 75, seniority: "head", pattern: /\bhead of\b/i },
  { rank: 65, seniority: "senior_manager", pattern: /\bsenior\s+(manager|consultant|recruiter)\b/i },
  { rank: 55, seniority: "manager", pattern: /\bmanager\b/i },
  { rank: 45, seniority: "lead", pattern: /\blead\b/i },
  { rank: 35, seniority: "senior", pattern: /\bsenior\b/i },
];

export function classifyTitle(title: string | null | undefined): {
  seniority: string;
  rank: number;
} {
  if (!title) return { seniority: "unknown", rank: 0 };
  for (const rule of SENIORITY_RULES) {
    if (rule.pattern.test(title)) {
      return { seniority: rule.seniority, rank: rule.rank };
    }
  }
  return { seniority: "ic", rank: 10 };
}

function lower(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function nameKey(c: { firstName: string | null; lastName: string | null }): string {
  return `${lower(c.firstName)}|${lower(c.lastName)}`;
}

// Merge: team_page provides name/title, hunter provides email/seniority.
function merge(team: CandidateContact, hunter: CandidateContact): CandidateContact {
  return {
    source: "team_page",
    firstName: team.firstName ?? hunter.firstName,
    lastName: team.lastName ?? hunter.lastName,
    title: team.title ?? hunter.title,
    email: team.email ?? hunter.email,
    linkedinUrl: team.linkedinUrl ?? hunter.linkedinUrl,
    hunterConfidence: hunter.hunterConfidence,
    hunterSeniority: hunter.hunterSeniority,
  };
}

export function dedupeAndRank(
  fromTeam: ExtractedPerson[],
  fromHunter: HunterEmail[],
  mailtoEmails: string[] = [],
): CandidateContact[] {
  const teamCandidates: CandidateContact[] = fromTeam.map((p) => {
    // Try to attach a mailto: email by name match if Claude didn't pull one.
    let inferredEmail = p.email ?? null;
    if (!inferredEmail) {
      const fnInitial = (p.first_name?.[0] ?? "").toLowerCase();
      const lnLower = lower(p.last_name);
      const exact = mailtoEmails.find((m) => {
        const local = m.split("@")[0].toLowerCase();
        return (
          local === `${lower(p.first_name)}.${lnLower}` ||
          local === `${lower(p.first_name)}${lnLower}` ||
          local === `${fnInitial}${lnLower}` ||
          local === `${lower(p.first_name)}` && lnLower.length === 0
        );
      });
      if (exact) inferredEmail = exact;
    }
    return {
      source: "team_page" as const,
      firstName: p.first_name || null,
      lastName: p.last_name || null,
      title: p.title || null,
      email: inferredEmail,
      linkedinUrl: null,
      hunterConfidence: null,
      hunterSeniority: null,
    };
  });

  const hunterCandidates: CandidateContact[] = fromHunter.map((e) => ({
    source: "hunter" as const,
    firstName: e.firstName,
    lastName: e.lastName,
    title: e.position,
    email: e.email,
    linkedinUrl: e.linkedin,
    hunterConfidence: e.confidence,
    hunterSeniority: e.seniority,
  }));

  // Dedupe in two passes.
  const byEmail = new Map<string, CandidateContact>();
  const byName = new Map<string, CandidateContact>();

  function admit(c: CandidateContact) {
    if (c.email) {
      const k = c.email.toLowerCase();
      const existing = byEmail.get(k);
      if (existing) {
        // team_page wins for fields it has, hunter wins for the ones it does
        if (c.source === "team_page") byEmail.set(k, merge(c, existing));
        else byEmail.set(k, merge(existing, c));
      } else {
        byEmail.set(k, c);
      }
      return;
    }
    const nk = nameKey(c);
    if (nk === "|") return; // both empty
    const existing = byName.get(nk);
    if (existing) {
      if (c.source === "team_page") byName.set(nk, merge(c, existing));
      else byName.set(nk, merge(existing, c));
    } else {
      byName.set(nk, c);
    }
  }

  for (const c of teamCandidates) admit(c);
  for (const c of hunterCandidates) admit(c);

  // Cross-pass: name-keyed entries that gained an email later via merge
  // would have been lost — re-run the pass to fold them under email keys.
  const all = [...byEmail.values(), ...byName.values()];
  byEmail.clear();
  byName.clear();
  for (const c of all) admit(c);

  return [...byEmail.values(), ...byName.values()];
}

export type ContactPersistOutcome = {
  inserted: number;
  updated: number;
  primaryContactId: string | null;
};

export async function persistContacts(
  companyId: string,
  candidates: CandidateContact[],
): Promise<ContactPersistOutcome> {
  const supabase = createServerClient();

  // Pull existing contacts so we don't write through with stale data.
  const { data: existing, error: existingErr } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email")
    .eq("company_id", companyId);
  if (existingErr) {
    throw new Error(`fetch existing contacts: ${existingErr.message}`);
  }

  const existingByEmail = new Map<string, { id: string }>();
  const existingByName = new Map<string, { id: string }>();
  for (const row of existing ?? []) {
    if (row.email) existingByEmail.set(row.email.toLowerCase(), { id: row.id });
    const nk = `${lower(row.first_name)}|${lower(row.last_name)}`;
    if (nk !== "|") existingByName.set(nk, { id: row.id });
  }

  let inserted = 0;
  let updated = 0;
  const persistedIds: Array<{ id: string; rank: number; verified: boolean }> = [];

  for (const c of candidates) {
    const { seniority, rank } = classifyTitle(c.title);

    const matchById =
      (c.email && existingByEmail.get(c.email.toLowerCase())?.id) ||
      existingByName.get(nameKey(c))?.id;

    const payload = {
      company_id: companyId,
      first_name: c.firstName,
      last_name: c.lastName,
      title: c.title,
      seniority,
      email: c.email ?? null,
      email_verified: false as const,
      linkedin_url: c.linkedinUrl,
      source: c.source,
      score: rank,
    };

    if (matchById) {
      const { error } = await supabase
        .from("contacts")
        .update(payload)
        .eq("id", matchById);
      if (!error) {
        updated += 1;
        persistedIds.push({ id: matchById, rank, verified: false });
      }
    } else {
      const { data, error } = await supabase
        .from("contacts")
        .insert(payload)
        .select("id")
        .single();
      if (!error && data) {
        inserted += 1;
        persistedIds.push({ id: data.id, rank, verified: false });
      }
    }
  }

  // Mark the highest-ranked contact (with an email) as primary.
  // Reset previous primary first so the marker is single-valued.
  await supabase
    .from("contacts")
    .update({ is_primary_contact: false })
    .eq("company_id", companyId)
    .eq("is_primary_contact", true);

  // Pick from the persisted set: prefer ones with emails, then highest rank.
  const sorted = [...persistedIds].sort((a, b) => b.rank - a.rank);
  let primaryContactId: string | null = null;
  // Re-read with email info to prefer rows that have an email.
  if (sorted.length > 0) {
    const { data: hydrated } = await supabase
      .from("contacts")
      .select("id, score, email")
      .in(
        "id",
        sorted.map((s) => s.id),
      );
    const ranked = (hydrated ?? [])
      .map((r) => ({
        id: r.id,
        score: r.score ?? 0,
        hasEmail: Boolean(r.email),
      }))
      .sort((a, b) => {
        if (a.hasEmail !== b.hasEmail) return a.hasEmail ? -1 : 1;
        return b.score - a.score;
      });
    primaryContactId = ranked[0]?.id ?? null;
    if (primaryContactId) {
      await supabase
        .from("contacts")
        .update({ is_primary_contact: true })
        .eq("id", primaryContactId);
    }
  }

  await logActivity("contacts_persisted", "company", companyId, {
    inserted,
    updated,
    candidates: candidates.length,
    primary_contact_id: primaryContactId,
  });

  return { inserted, updated, primaryContactId };
}
