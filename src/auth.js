import { supabase } from './supabaseClient.js'

// Google-only auth. No email/password path is exposed in this app.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) throw error
}

export async function signOut() {
  await supabase.auth.signOut()
}

export function onAuthChange(callback) {
  supabase.auth.getSession().then(({ data }) => callback(data.session))
  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => callback(session))
  return () => sub.subscription.unsubscribe()
}
