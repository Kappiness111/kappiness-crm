// Supabase connection settings, read from .env.local (or the host's environment variables).
// The names must be written out literally: Next.js only inlines NEXT_PUBLIC_* values into browser code
// when it sees `process.env.NEXT_PUBLIC_...` spelled out in full.
//
// Get the values from the Supabase Dashboard → your project → Project Settings → API Keys / Data API:
//   NEXT_PUBLIC_SUPABASE_URL              Project URL (https://<project-ref>.supabase.co)
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  Publishable key (sb_publishable_...)
// Never use the secret / service_role key here: these values are shipped to the browser.

const REQUIRED = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']

export class SupabaseConfigError extends Error {
  constructor(missing) {
    super(
      `Supabase is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing. ` +
        `Add ${missing.length > 1 ? 'them' : 'it'} to .env.local in the project root (values from Supabase Dashboard → Project Settings → API Keys), ` +
        'then restart the dev server or rebuild.'
    )
    this.name = 'SupabaseConfigError'
    this.missing = missing
  }
}

// Returns { url, key }, or throws SupabaseConfigError naming the missing variables (never their values).
export function getSupabaseEnv() {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  }
  const missing = REQUIRED.filter((name) => !String(values[name] || '').trim())
  if (missing.length > 0) throw new SupabaseConfigError(missing)

  const url = values.NEXT_PUBLIC_SUPABASE_URL.trim()
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new SupabaseConfigError(['a valid NEXT_PUBLIC_SUPABASE_URL (it must start with https://)'])
  }
  return { url, key: values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.trim() }
}
