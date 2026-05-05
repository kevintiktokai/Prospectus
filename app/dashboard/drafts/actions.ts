"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logger";

export async function approveDraft(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerClient();
  await supabase
    .from("email_sequences")
    .update({ status: "approved" })
    .eq("id", id)
    .eq("status", "draft");
  await logActivity("draft_approved", "email_sequence", id);
  revalidatePath("/dashboard/drafts");
}

export async function rejectDraft(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").slice(0, 500);
  if (!id) return;
  const supabase = createServerClient();
  await supabase
    .from("email_sequences")
    .update({ status: "failed" })
    .eq("id", id);
  await logActivity(
    "draft_rejected",
    "email_sequence",
    id,
    { reason: reason || "(none)" },
    "warning",
  );
  revalidatePath("/dashboard/drafts");
}

export async function saveDraftEdit(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!id || !subject || !body) return;

  const supabase = createServerClient();
  await supabase
    .from("email_sequences")
    .update({ subject, body })
    .eq("id", id)
    .eq("status", "draft");
  await logActivity("draft_edited", "email_sequence", id, {
    subject_length: subject.length,
    body_length: body.length,
  });
  revalidatePath("/dashboard/drafts");
}
