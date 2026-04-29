import Link from "next/link";
import { notFound } from "next/navigation";
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
import type { Company, Signal } from "@/types/database";

export const dynamic = "force-dynamic";

type Detail = {
  company: Company | null;
  signals: Signal[];
  error: string | null;
};

async function fetchDetail(id: string): Promise<Detail> {
  try {
    const supabase = createServerClient();
    const [{ data: company, error: cErr }, { data: signals }] =
      await Promise.all([
        supabase.from("companies").select("*").eq("id", id).maybeSingle(),
        supabase
          .from("signals")
          .select("*")
          .eq("company_id", id)
          .order("detected_at", { ascending: false })
          .limit(20),
      ]);
    if (cErr) {
      return { company: null, signals: [], error: cErr.message };
    }
    return {
      company: (company ?? null) as Company | null,
      signals: (signals ?? []) as Signal[],
      error: null,
    };
  } catch (err) {
    return {
      company: null,
      signals: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "enriched"
      ? "bg-emerald-100 text-emerald-800"
      : status === "failed"
        ? "bg-red-100 text-red-800"
        : status === "enriching"
          ? "bg-blue-100 text-blue-800"
          : status === "skipped"
            ? "bg-zinc-100 text-zinc-700"
            : "bg-amber-100 text-amber-800";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {status}
    </span>
  );
}

export default async function CompanyDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { company, signals, error } = await fetchDetail(params.id);

  if (error) {
    return (
      <div className="space-y-6 p-8">
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load company</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!company) notFound();

  const services = asArray(company.services);
  const techStack = asArray(company.tech_stack);

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-end justify-between">
        <div>
          <Link
            href="/dashboard/companies"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Companies
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {company.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {company.domain ?? "—"} · {company.city ?? "—"}
          </p>
        </div>
        <StatusPill status={company.enrichment_status} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Field label="Description">
              {company.description ?? (
                <span className="text-muted-foreground">
                  Not enriched yet.
                </span>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Sub-industry">
                {company.sub_industry ?? "—"}
              </Field>
              <Field label="Employees (est.)">
                {company.employee_estimate ?? "—"}
              </Field>
              <Field label="Score">{company.score ?? "—"}</Field>
              <Field label="Source">{company.source}</Field>
              <Field label="Discovered">
                {new Date(company.discovered_at).toLocaleString()}
              </Field>
              <Field label="Last enriched">
                {company.last_enriched_at
                  ? new Date(company.last_enriched_at).toLocaleString()
                  : "—"}
              </Field>
            </div>
            {company.website && (
              <Field label="Website">
                <a
                  href={company.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {company.website}
                </a>
              </Field>
            )}
            {company.enrichment_error && (
              <Field label="Last error">
                <code className="break-all text-xs">
                  {company.enrichment_error}
                </code>
              </Field>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Services</CardTitle>
          </CardHeader>
          <CardContent>
            {services.length === 0 ? (
              <div className="text-sm text-muted-foreground">—</div>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {services.map((s) => (
                  <li key={s} className="rounded bg-muted px-2 py-1">
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tech stack signals</CardTitle>
        </CardHeader>
        <CardContent>
          {techStack.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No tools detected on the site.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {techStack.map((t) => (
                <span
                  key={t}
                  className="rounded-md border px-2 py-0.5 text-xs"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Signals ({signals.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No signals yet. Phase 4 will populate this.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="text-right">Detected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signals.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">
                      {s.type}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {s.title ?? s.url}
                        </a>
                      ) : (
                        s.title ?? "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {new Date(s.detected_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
