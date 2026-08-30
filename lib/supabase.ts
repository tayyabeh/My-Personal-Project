/**
 * The database connection.
 *
 * We always connect with the "service_role" key, which bypasses the
 * row-level security rules in schema.sql. That is safe here because this
 * client is only ever created on the server — never in browser code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.supabaseUrl(), env.supabaseServiceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
