import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Company, EnrichmentStatus } from "@/types/database";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const ENRICHMENT_STATUSES: EnrichmentStatus[] = [
  "pending",
  "enriching",
  "enriched",
  "failed",
];

type SearchParams = {
  page?: string;
  source?: string;
  city?: string;
  status?: string;
  q?: string;
};

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

async function fetchDistinct(
  supabase: ReturnType<typeof createServerClient>,
  column: "source" | "city",
): Promise<string[]> {
  const { data } = await supabase
    .from("companies")
    .select(column)
    .not(column, "is", null);
  const values = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, string | null>>) {
    const v = row[column];
    if (v) values.add(v);
  }
  return Array.from(values).sort();
}

async function fetchPage(params: SearchParams): Promise<{
  rows: Company[];
  total: number;
  page: number;
  totalPages: number;
  sources: string[];
  cities: string[];
  error: string | null;
}> {
  const page = parsePage(params.page);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  try {
    const supabase = createServerClient();

    let query = supabase
      .from("companies")
      .select("*", { count: "exact" })
      .order("discovered_at", { ascending: false })
      .range(from, to);

    if (params.source) query = query.eq("source", params.source);
    if (params.city) query = query.eq("city", params.city);
    if (params.status)
      query = query.eq("enrichment_status", params.status as EnrichmentStatus);
    if (params.q && params.q.trim()) {
      const q = params.q.trim().replace(/[,()]/g, " ");
      query = query.or(`name.ilike.%${q}%,domain.ilike.%${q}%`);
    }

    const [{ data, count, error }, sources, cities] = await Promise.all([
      query,
      fetchDistinct(supabase, "source"),
      fetchDistinct(supabase, "city"),
    ]);

    if (error) {
      return {
        rows: [],
        total: 0,
        page,
        totalPages: 1,
        sources: [],
        cities: [],
        error: error.message,
      };
    }

    const total = count ?? 0;
    return {
      rows: (data ?? []) as Company[],
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      sources,
      cities,
      error: null,
    };
  } catch (err) {
    return {
      rows: [],
      total: 0,
      page,
      totalPages: 1,
      sources: [],
      cities: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function buildPageHref(base: SearchParams, page: number): string {
  const sp = new URLSearchParams();
  if (base.q) sp.set("q", base.q);
  if (base.source) sp.set("source", base.source);
  if (base.city) sp.set("city", base.city);
  if (base.status) sp.set("status", base.status);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/dashboard/companies?${qs}` : "/dashboard/companies";
}

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { rows, total, page, totalPages, sources, cities, error } =
    await fetchPage(searchParams);

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} total · page {page} of {totalPages}
          </p>
        </div>
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load companies</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <form
            method="get"
            action="/dashboard/companies"
            className="grid grid-cols-1 gap-3 md:grid-cols-5"
          >
            <input
              type="text"
              name="q"
              defaultValue={searchParams.q ?? ""}
              placeholder="Search name or domain"
              className="col-span-2 h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <select
              name="source"
              defaultValue={searchParams.source ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              name="city"
              defaultValue={searchParams.city ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All cities</option>
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              name="status"
              defaultValue={searchParams.status ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All statuses</option>
              {ENRICHMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="md:col-span-5 flex gap-2">
              <button
                type="submit"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Apply
              </button>
              <Link
                href="/dashboard/companies"
                className="flex h-9 items-center rounded-md border px-4 text-sm"
              >
                Reset
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No companies match these filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="text-right">Employees</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Discovered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.domain ? (
                        <a
                          className="hover:underline"
                          href={`https://${c.domain}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {c.domain}
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.city ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {c.employee_estimate ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {c.score ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.enrichment_status}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {new Date(c.discovered_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <div>
          Showing {rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–
          {(page - 1) * PAGE_SIZE + rows.length} of {total.toLocaleString()}
        </div>
        <div className="flex gap-2">
          <Link
            href={buildPageHref(searchParams, Math.max(1, page - 1))}
            aria-disabled={page <= 1}
            className={`flex h-9 items-center rounded-md border px-3 ${
              page <= 1 ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Previous
          </Link>
          <Link
            href={buildPageHref(searchParams, Math.min(totalPages, page + 1))}
            aria-disabled={page >= totalPages}
            className={`flex h-9 items-center rounded-md border px-3 ${
              page >= totalPages ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Next
          </Link>
        </div>
      </div>
    </div>
  );
}
