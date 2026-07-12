import { supabase } from './supabaseClient.js'

// Google-only auth. No email/password path is exposed in this app.
// redirectTo carries the current hash (e.g. #/note/39) so a deep link survives
// the login round-trip instead of dropping the user back on the home view.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname + window.location.hash },
  })
  if (error) throw error
}

export async function signOut() {
  await supabase.auth.signOut()
}

// id=476§一: the event type is passed through (not just the session) so a
// caller can tell a real sign-in/sign-out transition apart from
// supabase-js's own silent background token rotation (TOKEN_REFRESHED),
// which fires periodically with no user action at all.
export function onAuthChange(callback) {
  supabase.auth.getSession().then(({ data }) => callback(data.session, 'INITIAL_SESSION'))
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => callback(session, event))
  return () => sub.subscription.unsubscribe()
}
