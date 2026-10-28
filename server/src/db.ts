import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

// A Supabase client that acts as the signed-in user. It never holds a
// service key: every query is checked by row-level security.

export type Db = SupabaseClient;

export function userDb(env: Env, accessToken: string): Db {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** The user's household id, created on first use. */
export async function householdId(db: Db): Promise<string> {
  const { data, error } = await db.rpc("ensure_household");
  if (error) throw new Error(`Couldn't open your household: ${error.message}`);
  return data as string;
}

/** Throws a readable error when a Supabase call fails. */
export function must<T>(
  result: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${what}: nothing came back`);
  return result.data;
}

export interface ItemRow {
  id: string;
  household_id: string;
  kind: "appliance" | "baby_gear" | "vehicle" | "other";
  category: string | null;
  nickname: string;
  brand: string | null;
  model: string | null;
  serial: string | null;
  purchased_on: string | null;
  uses_per_week: number | null;
  child_id: string | null;
  notes: string | null;
}

export interface ManualRow {
  id: string;
  item_id: string;
  title: string | null;
  source: string;
  source_url: string | null;
  official: boolean | null;
  storage_path: string | null;
  page_count: number | null;
  status: "pending" | "needs_source" | "text_ready" | "distilled" | "failed";
  status_detail: string | null;
  read_by: string | null;
}

export interface TaskRow {
  id: string;
  item_id: string;
  title: string;
  details: string | null;
  interval_unit: "days" | "weeks" | "months" | "cycles" | "once" | "as_needed";
  interval_value: number | null;
  next_due_on: string | null;
  last_done_on: string | null;
  source_manual_id: string | null;
  source_page: number | null;
  source: "reader" | "assistant" | "user";
  status: "extracted" | "needs_review" | "revised" | "confirmed";
  active: boolean;
}

export interface ChildRow {
  id: string;
  nickname: string;
  birth_date: string | null;
  growth_sex: "female" | "male" | null;
}

export interface MeasurementRow {
  id: string;
  child_id: string;
  measured_on: string;
  height_cm: number | null;
  weight_kg: number | null;
}

export interface SeatModeRow {
  id: string;
  item_id: string;
  mode: "rear_facing" | "forward_facing" | "booster_high_back" | "booster_backless";
  min_weight_kg: number | null;
  max_weight_kg: number | null;
  min_height_cm: number | null;
  max_height_cm: number | null;
  min_age_months: number | null;
  fit_note: string | null;
  source_page: number | null;
}
