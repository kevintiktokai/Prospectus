// Hand-rolled row types for the Phase 1 schema. Replace with
// `supabase gen types typescript --linked` output once we're connected.

export type EnrichmentStatus =
  | "pending"
  | "enriching"
  | "enriched"
  | "failed"
  | "skipped";

export type SignalType =
  | "job_post"
  | "blog_post"
  | "news"
  | "funding"
  | "hiring_surge"
  | "leadership_change"
  | "tech_change"
  | "pain_mention"
  | "linkedin_post"
  | "press_release";

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export type EmailSequenceStatus =
  | "draft"
  | "approved"
  | "queued"
  | "sent"
  | "opened"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "failed";

export type ReplyClassification =
  | "interested"
  | "objection"
  | "not_now"
  | "not_interested"
  | "ooo"
  | "auto_reply";

export type ActivityStatus = "success" | "error" | "warning";

export type Company = {
  id: string;
  name: string;
  website: string | null;
  domain: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  sub_industry: string | null;
  employee_estimate: number | null;
  description: string | null;
  services: unknown;
  tech_stack: unknown;
  source: string;
  source_metadata: Record<string, unknown>;
  score: number | null;
  discovered_at: string;
  last_enriched_at: string | null;
  enrichment_status: EnrichmentStatus;
  enrichment_error: string | null;
  created_at: string;
  updated_at: string;
}

export type Contact = {
  id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  title: string | null;
  seniority: string | null;
  email: string | null;
  email_verified: boolean;
  email_verification_status: string | null;
  email_verified_at: string | null;
  linkedin_url: string | null;
  source: string;
  is_primary_contact: boolean;
  score: number | null;
  created_at: string;
  updated_at: string;
}

export type Signal = {
  id: string;
  company_id: string;
  type: SignalType;
  title: string | null;
  content: string | null;
  url: string | null;
  detected_at: string;
  relevance_score: number | null;
  is_primary: boolean;
  created_at: string;
}

export type Campaign = {
  id: string;
  name: string;
  icp_description: string | null;
  value_prop: string | null;
  target_country: string | null;
  target_industry: string | null;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
}

export type EmailSequence = {
  id: string;
  contact_id: string;
  campaign_id: string;
  signal_id: string | null;
  sequence_step: number;
  subject: string | null;
  body: string | null;
  status: EmailSequenceStatus;
  smartlead_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  reply_body: string | null;
  reply_classification: ReplyClassification | null;
  created_at: string;
  updated_at: string;
}

export type ActivityLog = {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  status: ActivityStatus;
  error_message: string | null;
  created_at: string;
}

export type Database = {
  public: {
    Tables: {
      companies: {
        Row: Company;
        Insert: Omit<
          Company,
          "id" | "discovered_at" | "created_at" | "updated_at"
        > &
          Partial<Pick<Company, "id" | "discovered_at">>;
        Update: Partial<Company>;
        Relationships: [];
      };
      contacts: {
        Row: Contact;
        Insert: Omit<
          Contact,
          "id" | "full_name" | "created_at" | "updated_at"
        > &
          Partial<Pick<Contact, "id">>;
        Update: Partial<Omit<Contact, "full_name">>;
        Relationships: [
          {
            foreignKeyName: "contacts_company_id_fkey";
            columns: ["company_id"];
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      signals: {
        Row: Signal;
        Insert: Omit<Signal, "id" | "detected_at" | "created_at"> &
          Partial<Pick<Signal, "id" | "detected_at">>;
        Update: Partial<Signal>;
        Relationships: [
          {
            foreignKeyName: "signals_company_id_fkey";
            columns: ["company_id"];
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: Campaign;
        Insert: Omit<Campaign, "id" | "created_at" | "updated_at"> &
          Partial<Pick<Campaign, "id">>;
        Update: Partial<Campaign>;
        Relationships: [];
      };
      email_sequences: {
        Row: EmailSequence;
        Insert: Omit<EmailSequence, "id" | "created_at" | "updated_at"> &
          Partial<Pick<EmailSequence, "id">>;
        Update: Partial<EmailSequence>;
        Relationships: [
          {
            foreignKeyName: "email_sequences_contact_id_fkey";
            columns: ["contact_id"];
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_sequences_campaign_id_fkey";
            columns: ["campaign_id"];
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_sequences_signal_id_fkey";
            columns: ["signal_id"];
            referencedRelation: "signals";
            referencedColumns: ["id"];
          },
        ];
      };
      activity_log: {
        Row: ActivityLog;
        Insert: Omit<ActivityLog, "id" | "created_at"> &
          Partial<Pick<ActivityLog, "id">>;
        Update: Partial<ActivityLog>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
