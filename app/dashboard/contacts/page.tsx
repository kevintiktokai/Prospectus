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
import type { Contact } from "@/types/database";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Row = Contact & { company: { id: string; name: string; domain: string | null } | null };

type SearchParams = {
  page?: string;
  verified?: string;
  primary?: string;
  q?: string;
};

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

async function fetchPage(params: SearchParams): Promise<{
  rows: Row[];
  total: number;
  page: number;
  totalPages: number;
  error: string | null;
}> {
  const page = parsePage(params.page);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  try {
    const supabase = createServerClient();
    let query = supabase
      .from("contacts")
      .select(
        "*, company:companies!inner(id,name,domain)",
        { count: "exact" },
      )
      .order("score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (params.verified === "yes") query = query.eq("email_verified", true);
    if (params.verified === "no") query = query.eq("email_verified", false);
    if (params.primary === "yes") query = query.eq("is_primary_contact", true);
    if (params.q && params.q.trim()) {
      const q = params.q.trim().replace(/[,()]/g, " ");
      query = query.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,title.ilike.%${q}%`,
      );
    }

    const { data, count, error } = await query;
    if (error) {
      return { rows: [], total: 0, page, totalPages: 1, error: error.message };
    }
    const total = count ?? 0;
    return {
      rows: (data ?? []) as unknown as Row[],
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      error: null,
    };
  } catch (err) {
    return {
      rows: [],
      total: 0,
      page,
      totalPages: 1,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function buildPageHref(base: SearchParams, page: number): string {
  const sp = new URLSearchParams();
  if (base.q) sp.set("q", base.q);
  if (base.verified) sp.set("verified", base.verified);
  if (base.primary) sp.set("primary", base.primary);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/dashboard/contacts?${qs}` : "/dashboard/contacts";
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { rows, total, page, totalPages, error } = await fetchPage(searchParams);

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          {total.toLocaleString()} total · page {page} of {totalPages}
        </p>
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load contacts</CardTitle>
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
            action="/dashboard/contacts"
            className="grid grid-cols-1 gap-3 md:grid-cols-5"
          >
            <input
              type="text"
              name="q"
              defaultValue={searchParams.q ?? ""}
              placeholder="Search name, email, or title"
              className="col-span-2 h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <select
              name="verified"
              defaultValue={searchParams.verified ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Any verification</option>
              <option value="yes">Verified</option>
              <option value="no">Unverified</option>
            </select>
            <select
              name="primary"
              defaultValue={searchParams.primary ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All contacts</option>
              <option value="yes">Primary only</option>
            </select>
            <div className="md:col-span-5 flex gap-2">
              <button
                type="submit"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Apply
              </button>
              <Link
                href="/dashboard/contacts"
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
              No contacts match these filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Primary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.full_name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.title ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.company ? (
                        <Link
                          href={`/dashboard/companies/${c.company.id}`}
                          className="hover:underline"
                        >
                          {c.company.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.email ? (
                        <span className="flex items-center gap-1.5">
                          <span>{c.email}</span>
                          {c.email_verified ? (
                            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                              ✓
                            </span>
                          ) : c.email_verification_status ? (
                            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700">
                              {c.email_verification_status}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.source}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.score ?? "—"}
                    </TableCell>
                    <TableCell>
                      {c.is_primary_contact ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          primary
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex justify-end gap-2 text-sm">
          {page > 1 && (
            <Link
              href={buildPageHref(searchParams, page - 1)}
              className="flex h-9 items-center rounded-md border px-3"
            >
              ← Prev
            </Link>
          )}
          {page < totalPages && (
            <Link
              href={buildPageHref(searchParams, page + 1)}
              className="flex h-9 items-center rounded-md border px-3"
            >
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
