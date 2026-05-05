import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { approveDraft, rejectDraft, saveDraftEdit } from "./actions";

export const dynamic = "force-dynamic";

type DraftRow = {
  id: string;
  subject: string | null;
  body: string | null;
  created_at: string;
  status: string;
  contact: {
    id: string;
    full_name: string | null;
    title: string | null;
    email: string | null;
    company: { id: string; name: string; domain: string | null } | null;
  } | null;
  signal: {
    id: string;
    type: string;
    title: string | null;
    url: string | null;
  } | null;
};

type SearchParams = {
  status?: string;
  edit?: string;
};

const STATUSES = ["draft", "approved", "failed"] as const;

type DraftStatus = (typeof STATUSES)[number];

async function fetchDrafts(status: DraftStatus): Promise<{
  rows: DraftRow[];
  counts: Record<string, number>;
  error: string | null;
}> {
  try {
    const supabase = createServerClient();
    const [{ data, error }, ...countResults] = await Promise.all([
      supabase
        .from("email_sequences")
        .select(
          `id, subject, body, created_at, status,
           contact:contacts!inner(
             id, full_name, title, email,
             company:companies!inner(id, name, domain)
           ),
           signal:signals(id, type, title, url)`,
        )
        .eq("sequence_step", 1)
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(100),
      ...STATUSES.map((s) =>
        supabase
          .from("email_sequences")
          .select("id", { count: "exact", head: true })
          .eq("sequence_step", 1)
          .eq("status", s),
      ),
    ]);

    if (error) {
      return { rows: [], counts: {}, error: error.message };
    }

    const counts: Record<string, number> = {};
    STATUSES.forEach((s, i) => {
      counts[s] = countResults[i].count ?? 0;
    });

    return {
      rows: (data ?? []) as unknown as DraftRow[],
      counts,
      error: null,
    };
  } catch (err) {
    return {
      rows: [],
      counts: {},
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const status: DraftStatus =
    searchParams.status &&
    (STATUSES as readonly string[]).includes(searchParams.status)
      ? (searchParams.status as DraftStatus)
      : "draft";
  const editingId = searchParams.edit ?? null;

  const { rows, counts, error } = await fetchDrafts(status);

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
        <p className="text-sm text-muted-foreground">
          Approval queue · review every email before it goes anywhere near
          Smartlead
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/dashboard/drafts?status=${s}`}
            className={`flex h-9 items-center rounded-md border px-3 capitalize ${
              s === status ? "bg-primary text-primary-foreground" : ""
            }`}
          >
            {s} <span className="ml-2 opacity-70">{counts[s] ?? 0}</span>
          </Link>
        ))}
      </div>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load drafts</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {status} drafts. {status === "draft" && "Run "}
            {status === "draft" && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                npm run draft:emails
              </code>
            )}
            {status === "draft" && " to generate some."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <DraftCard key={row.id} draft={row} editing={editingId === row.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  draft,
  editing,
}: {
  draft: DraftRow;
  editing: boolean;
}) {
  const contactName = draft.contact?.full_name?.trim() || "(no name)";
  const company = draft.contact?.company;

  return (
    <Card>
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>
              {company ? (
                <Link
                  href={`/dashboard/companies/${company.id}`}
                  className="hover:underline"
                >
                  {company.name}
                </Link>
              ) : (
                "(no company)"
              )}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {company?.domain ?? ""}
              </span>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {contactName}
              {draft.contact?.title ? ` · ${draft.contact.title}` : ""}
              {draft.contact?.email ? ` · ${draft.contact.email}` : ""}
            </p>
            {draft.signal && (
              <p className="text-xs text-muted-foreground">
                Hook ({draft.signal.type}):{" "}
                {draft.signal.url ? (
                  <a
                    href={draft.signal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {draft.signal.title ?? draft.signal.url}
                  </a>
                ) : (
                  draft.signal.title ?? "—"
                )}
              </p>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {new Date(draft.created_at).toLocaleString()}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {editing ? (
          <form action={saveDraftEdit} className="space-y-3">
            <input type="hidden" name="id" value={draft.id} />
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Subject
              </label>
              <input
                name="subject"
                defaultValue={draft.subject ?? ""}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                required
              />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-muted-foreground">
                Body
              </label>
              <textarea
                name="body"
                defaultValue={draft.body ?? ""}
                rows={10}
                className="mt-1 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
                required
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Save
              </button>
              <Link
                href={`/dashboard/drafts?status=${draft.status}`}
                className="flex h-9 items-center rounded-md border px-4 text-sm"
              >
                Cancel
              </Link>
            </div>
          </form>
        ) : (
          <>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Subject
              </div>
              <div className="mt-1 font-medium">{draft.subject ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Body
              </div>
              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-sm">
                {draft.body ?? ""}
              </pre>
            </div>
          </>
        )}

        {!editing && draft.status === "draft" && (
          <div className="flex flex-wrap gap-2">
            <form action={approveDraft} className="contents">
              <input type="hidden" name="id" value={draft.id} />
              <button
                type="submit"
                className="h-9 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Approve
              </button>
            </form>
            <Link
              href={`/dashboard/drafts?status=draft&edit=${draft.id}`}
              className="flex h-9 items-center rounded-md border px-4 text-sm"
            >
              Edit
            </Link>
            <form action={rejectDraft} className="flex gap-2">
              <input type="hidden" name="id" value={draft.id} />
              <input
                type="text"
                name="reason"
                placeholder="Reject reason (optional)"
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
              <button
                type="submit"
                className="h-9 rounded-md border border-red-200 px-4 text-sm text-red-700 hover:bg-red-50"
              >
                Reject
              </button>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
