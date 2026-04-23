import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";
import {
  isJobBoardDomain,
  isSocialDomain,
  normalizeDomain,
} from "@/lib/utils/domain";
import type { PlaceResult } from "@/lib/scrapers/google-places";

export type UpsertOutcome =
  | { inserted: true; company_id: string }
  | {
      inserted: false;
      company_id: string | null;
      reason:
        | "duplicate"
        | "no_website"
        | "social_url"
        | "job_board"
        | "low_quality";
    };

// Skip heuristics applied before we touch the DB.
function screen(
  place: PlaceResult,
  domain: string | null,
):
  | { skip: true; reason: "no_website" | "social_url" | "job_board" | "low_quality" }
  | { skip: false } {
  if (!place.website || !domain) return { skip: true, reason: "no_website" };
  if (isSocialDomain(domain)) return { skip: true, reason: "social_url" };
  if (isJobBoardDomain(domain)) return { skip: true, reason: "job_board" };
  // Dead/fake listings: very few ratings and no website description.
  if (place.userRatingCount < 3 && !place.website) {
    return { skip: true, reason: "low_quality" };
  }
  return { skip: false };
}

export async function upsertCompany(
  place: PlaceResult,
  fallbackCity: string | null = null,
  source = "google_places",
): Promise<UpsertOutcome> {
  const domain = normalizeDomain(place.website);
  const screened = screen(place, domain);

  if (screened.skip) {
    await logActivity(
      "company_upsert_skipped",
      "company",
      null,
      {
        reason: screened.reason,
        name: place.name,
        website: place.website,
        place_id: place.placeId,
      },
      "warning",
    );
    return { inserted: false, company_id: null, reason: screened.reason };
  }

  const supabase = createServerClient();

  // Dedup on domain. Pre-check before insert so we can log the outcome
  // precisely; the unique index still backstops concurrent writers.
  const { data: existing, error: lookupErr } = await supabase
    .from("companies")
    .select("id")
    .eq("domain", domain as string)
    .maybeSingle();

  if (lookupErr) {
    await logActivity(
      "company_upsert_error",
      "company",
      null,
      { name: place.name, domain, stage: "lookup" },
      "error",
      lookupErr.message,
    );
    throw new Error(`Lookup failed for ${domain}: ${lookupErr.message}`);
  }

  if (existing) {
    await logActivity("company_upsert", "company", existing.id, {
      name: place.name,
      domain,
      inserted: false,
      reason: "duplicate",
      place_id: place.placeId,
    });
    return {
      inserted: false,
      company_id: existing.id,
      reason: "duplicate",
    };
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("companies")
    .insert({
      name: place.name,
      website: place.website,
      domain,
      country: place.country ?? "GB",
      city: place.city ?? fallbackCity,
      industry: "Recruitment",
      sub_industry: null,
      employee_estimate: null,
      description: null,
      services: [],
      tech_stack: [],
      source,
      source_metadata: {
        place_id: place.placeId,
        phone: place.phone,
        address: place.address,
        types: place.types,
        rating: place.rating,
        user_rating_count: place.userRatingCount,
        raw: place.raw,
      },
      score: null,
      last_enriched_at: null,
      enrichment_status: "pending",
      enrichment_error: null,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    // Unique-violation race: another worker won. Treat as duplicate.
    if (insertErr?.code === "23505") {
      const { data: post } = await supabase
        .from("companies")
        .select("id")
        .eq("domain", domain as string)
        .maybeSingle();
      await logActivity("company_upsert", "company", post?.id ?? null, {
        name: place.name,
        domain,
        inserted: false,
        reason: "duplicate_race",
        place_id: place.placeId,
      });
      return {
        inserted: false,
        company_id: post?.id ?? null,
        reason: "duplicate",
      };
    }

    await logActivity(
      "company_upsert_error",
      "company",
      null,
      { name: place.name, domain, stage: "insert" },
      "error",
      insertErr?.message ?? "unknown insert error",
    );
    throw new Error(
      `Insert failed for ${place.name} (${domain}): ${insertErr?.message ?? "unknown"}`,
    );
  }

  await logActivity("company_upsert", "company", inserted.id, {
    name: place.name,
    domain,
    inserted: true,
    place_id: place.placeId,
  });

  return { inserted: true, company_id: inserted.id };
}
