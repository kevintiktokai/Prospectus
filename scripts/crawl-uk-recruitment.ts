// Phase 2 crawl orchestrator. Run with:
//   npx tsx scripts/crawl-uk-recruitment.ts
//
// Reads env from .env.local. Iterates every (city × searchTerm) pair in
// the UK recruitment config, upserts each discovered place into the
// companies table, and logs one activity_log entry per query plus one
// summary entry at the end.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { UK_RECRUITMENT_CRAWL } from "../config/crawlers/uk-recruitment";
import { searchPlaces } from "../lib/scrapers/google-places";
import { upsertCompany } from "../lib/scrapers/company-writer";
import { logActivity } from "../lib/logger";

type Stats = {
  queries: number;
  placesFound: number;
  inserted: number;
  duplicates: number;
  skippedNoWebsite: number;
  skippedSocial: number;
  skippedJobBoard: number;
  skippedLowQuality: number;
  errors: number;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const startedAt = Date.now();
  const { searchTerms, cities, radiusMeters, source } = UK_RECRUITMENT_CRAWL;
  const totalQueries = cities.length * searchTerms.length;

  console.log(
    `[crawl] starting UK recruitment crawl — ${totalQueries} queries across ${cities.length} cities × ${searchTerms.length} terms`,
  );

  const stats: Stats = {
    queries: 0,
    placesFound: 0,
    inserted: 0,
    duplicates: 0,
    skippedNoWebsite: 0,
    skippedSocial: 0,
    skippedJobBoard: 0,
    skippedLowQuality: 0,
    errors: 0,
  };

  for (const city of cities) {
    for (const term of searchTerms) {
      const query = `${term} in ${city.name}`;
      stats.queries++;

      try {
        const results = await searchPlaces(
          query,
          { lat: city.lat, lng: city.lng },
          radiusMeters,
        );
        stats.placesFound += results.length;

        await logActivity("crawl_query", "crawler", null, {
          source,
          query,
          city: city.name,
          term,
          results_count: results.length,
        });

        for (const place of results) {
          try {
            const outcome = await upsertCompany(place, city.name, source);
            if (outcome.inserted) {
              stats.inserted++;
            } else {
              switch (outcome.reason) {
                case "duplicate":
                  stats.duplicates++;
                  break;
                case "no_website":
                  stats.skippedNoWebsite++;
                  break;
                case "social_url":
                  stats.skippedSocial++;
                  break;
                case "job_board":
                  stats.skippedJobBoard++;
                  break;
                case "low_quality":
                  stats.skippedLowQuality++;
                  break;
              }
            }
          } catch (err) {
            stats.errors++;
            console.error(
              `[crawl] upsert error for "${place.name}":`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        console.log(
          `[crawl] ${stats.queries}/${totalQueries}  ${city.name} · ${term} → ${results.length} places (inserted ${stats.inserted}, dup ${stats.duplicates})`,
        );
      } catch (err) {
        stats.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[crawl] query failed "${query}": ${message}`);
        await logActivity(
          "crawl_query",
          "crawler",
          null,
          { source, query, city: city.name, term },
          "error",
          message,
        );
      }

      await sleep(200);
    }
  }

  const durationMs = Date.now() - startedAt;

  await logActivity("crawl_completed", "crawler", null, {
    source,
    duration_ms: durationMs,
    ...stats,
  });

  console.log("\n[crawl] done");
  console.log("  duration:        ", `${(durationMs / 1000).toFixed(1)}s`);
  console.log("  queries:         ", stats.queries);
  console.log("  places found:    ", stats.placesFound);
  console.log("  inserted:        ", stats.inserted);
  console.log("  duplicates:      ", stats.duplicates);
  console.log("  skipped (no web):", stats.skippedNoWebsite);
  console.log("  skipped (social):", stats.skippedSocial);
  console.log("  skipped (jobs):  ", stats.skippedJobBoard);
  console.log("  skipped (lowqa): ", stats.skippedLowQuality);
  console.log("  errors:          ", stats.errors);
}

main().catch((err) => {
  console.error("[crawl] fatal error:", err);
  process.exit(1);
});
