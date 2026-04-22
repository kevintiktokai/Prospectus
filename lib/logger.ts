import { createServerClient } from "@/lib/supabase/server";
import type { ActivityStatus } from "@/types/database";

// Every scraper, enricher, drafter, and sender calls this. Keeps the
// Activity Log tab as a single source of truth for what the system did.
// Never throws — failing to log should not break a pipeline.
export async function logActivity(
  action: string,
  entityType: string | null = null,
  entityId: string | null = null,
  metadata: Record<string, unknown> = {},
  status: ActivityStatus = "success",
  errorMessage: string | null = null,
): Promise<void> {
  try {
    const supabase = createServerClient();
    const { error } = await supabase.from("activity_log").insert({
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata,
      status,
      error_message: errorMessage,
    });
    if (error) {
      console.error("[logActivity] insert failed:", error.message);
    }
  } catch (err) {
    console.error("[logActivity] unexpected error:", err);
  }
}
