
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../utils/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function handleLogin(event) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const supabase = createClient()

      const { error: loginError } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })

      if (loginError) {
        setError('Login failed. Check your email and password.')
        return
      }

      router.replace('/')
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogleLogin() {
  setError('')
  setGoogleLoading(true)

  try {
    const supabase = createClient()

    const { error: googleError } =
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      })

    if (googleError) {
      setError('Google sign-in could not start. Please try again.')
      setGoogleLoading(false)
    }
  } catch {
    setError('Something went wrong with Google sign-in.')
    setGoogleLoading(false)
  }
}

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-3xl font-bold text-gray-900">
          Kappiness CRM
        </h1>

        <p className="mt-2 text-gray-600">
          Sign in to your staff account
        </p>

        <form onSubmit={handleLogin} className="mt-8 space-y-5">
          <div>
            <label htmlFor="email" className="mb-2 block text-sm font-medium">
              Email address
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="staff@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-2 focus:ring-purple-500"
              placeholder="Enter your password"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || googleLoading}
            className="w-full rounded-lg bg-purple-700 px-4 py-3 font-semibold text-white hover:bg-purple-800 disabled:opacity-60"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          <div className="my-5 flex items-center gap-3 text-sm text-gray-500">
  <span className="h-px flex-1 bg-gray-200" />
  <span>or continue with</span>
  <span className="h-px flex-1 bg-gray-200" />
</div>

<button
  type="button"
  onClick={handleGoogleLogin}
  disabled={loading || googleLoading}
  className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-3 font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-60"
>
  <span className="text-xl font-bold text-blue-600" aria-hidden="true">
    G
  </span>
  {googleLoading ? 'Connecting to Google...' : 'Continue with Google'}
</button>
        </form>
      </div>
    </main>
  )
}
