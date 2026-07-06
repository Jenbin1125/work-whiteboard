import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
}

// Anon/publishable key only. RLS on work_whiteboard enforces per-owner access —
// this client must never be given a service_role key.
export const supabase = createClient(url, anonKey)
