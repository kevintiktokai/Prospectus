// Phase 5 batch runner. Walks every enriched company that hasn't had
// a contact scan yet (or every company if --rescan), runs the
// per-company orchestrator, and prints a summary.
//
// Concurrency defaults to 2 — Hunter rate-limits at ~10 req/s on paid
// plans and team-page scraping uses Playwright (heavy). Per-company
// NeverBounce calls are serialised inside the verifier.
//
// Run:  npm run find:contacts
//       npm run find:contacts -- --limit 50
//       npm run find:contacts -- --concurrency 1
//       npm run find:contacts -- --skip-verify
//       npm run find:contacts -- --rescan

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import pLimit from "p-limit";
import Anthropic from "@anthropic-ai/sdk";

import { createServerClient } from "../lib/supabase/server";
import { logActivity } from "../lib/logger";
import { findContacts } from "../lib/enrichment/contact-finder";
import { closeBrowser } from "../lib/scrapers/_browser";
import type { Company } from "../types/database";

type Row = Pick<Company, "id" | "name" | "website" | "domain">;

function parseFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function fetchTargets(opts: {
  limit: number | null;
  rescan: boolean;
}): Promise<Row[]> {
  const supabase = createServerClient();
  const pageSize = 1000;
  let from = 0;
  const rows: Row[] = [];
  for (;;) {
    const remaining = opts.limit ? Math.max(0, opts.limit - rows.length) : pageSize;
    if (opts.limit && remaining <= 0) break;
    const cap = Math.min(pageSize, remaining || pageSize);
    let query = supabase
      .from("companies")
      .select("id,name,website,domain")
      .eq("enrichment_status", "enriched")
      .not("domain", "is", null);
    if (!opts.rescan) {
      query = query.is("last_contacts_scan_at", null);
    }
    const { data, error } = await query
      .order("score", { ascending: false, nullsFirst: false })
      .range(from, from + cap - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < cap) break;
    from += cap;
  }
  return rows;
}

async function main() {
  const limit = Number(parseFlag("limit") ?? 0) || null;
  const concurrency = Math.max(1, Number(parseFlag("concurrency") ?? 2));
  const rescan = hasFlag("rescan");
  const skipVerify = hasFlag("skip-verify");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY (team-page extraction needs it)");
  }
  if (!process.env.HUNTER_API_KEY) {
    console.warn(
      "[contacts] HUNTER_API_KEY not set — Hunter step will be skipped per-row.",
    );
  }
  if (!skipVerify && !process.env.NEVERBOUNCE_API_KEY) {
    console.warn(
      "[contacts] NEVERBOUNCE_API_KEY not set — emails will be persisted unverified. Pass --skip-verify to silence.",
    );
  }

  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const startedAt = Date.now();
  const rows = await fetchTargets({ limit, rescan });
  console.log(
    `[contacts] ${rows.length} target companies, concurrency=${concurrency}, rescan=${rescan}, skipVerify=${skipVerify}`,
  );

  const tally = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    primaryFound: 0,
    teamPeople: 0,
    hunterEmails: 0,
    verifiedValid: 0,
    errors: 0,
    hunterRemaining: null as number | null,
  };

  const limiter = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    rows.map((row) =>
      limiter(async () => {
        try {
          const out = await findContacts(row, { client: ai, skipVerify });
          tally.scanned += 1;
          tally.inserted += out.persisted.inserted;
          tally.updated += out.persisted.updated;
          if (out.persisted.primary_id) tally.primaryFound += 1;
          tally.teamPeople += out.team.people;
          tally.hunterEmails += out.hunter.emails;
          tally.verifiedValid += out.verified.valid;
          if (out.hunter.remaining !== null) {
            tally.hunterRemaining = out.hunter.remaining;
          }
        } catch (err) {
          tally.errors += 1;
          await logActivity(
            "contacts_scan_error",
            "company",
            row.id,
            { domain: row.domain, name: row.name },
            "error",
            err instanceof Error ? err.message : String(err),
          );
        }
        processed += 1;
        if (processed % 10 === 0) {
          console.log(
            `[contacts] ${processed}/${rows.length} — primary=${tally.primaryFound} valid=${tally.verifiedValid} errors=${tally.errors}`,
          );
        }
      }),
    ),
  );

  const ms = Date.now() - startedAt;
  await closeBrowser();

  await logActivity("contacts_batch_completed", null, null, {
    ...tally,
    duration_ms: ms,
    concurrency,
    rescan,
    skip_verify: skipVerify,
  });

  console.log("");
  console.log("[contacts] summary");
  console.log(`  scanned:           ${tally.scanned}`);
  console.log(`  contacts inserted: ${tally.inserted}`);
  console.log(`  contacts updated:  ${tally.updated}`);
  console.log(`  primary found:     ${tally.primaryFound} / ${tally.scanned}`);
  console.log(`  team people seen:  ${tally.teamPeople}`);
  console.log(`  hunter emails:     ${tally.hunterEmails}`);
  console.log(`  verified valid:    ${tally.verifiedValid}`);
  console.log(`  errors:            ${tally.errors}`);
  if (tally.hunterRemaining !== null) {
    console.log(`  Hunter credits left: ${tally.hunterRemaining}`);
  }
  console.log(`  duration:          ${(ms / 1000).toFixed(1)}s`);
  if (rows.length > 0) {
    const ratio = ((tally.primaryFound / rows.length) * 100).toFixed(1);
    console.log(`  primary rate:      ${ratio}% (gate: ≥40%)`);
  }
}

main().catch(async (err) => {
  console.error("[contacts] fatal:", err);
  await closeBrowser();
  process.exit(1);
});
