import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const timestamp = new Date().toISOString();

  try {
    const supabase = createServerClient();
    // Cheap round-trip: HEAD count on a table that exists after migration.
    const { error } = await supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true });

    if (error) {
      return NextResponse.json(
        { ok: false, timestamp, error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, timestamp });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        timestamp,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
