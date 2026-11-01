'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { createClient } from '../../utils/supabase/client'
import styles from './login.module.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Client-side checks that run before Supabase is called.
function validate(email, password) {
  const errors = {}
  const trimmed = email.trim()

  if (!trimmed) errors.email = 'Enter your work email.'
  else if (!EMAIL_PATTERN.test(trimmed)) {
    errors.email = 'Enter a valid email address, like name@example.com.'
  }

  if (!password) errors.password = 'Enter your password.'

  return errors
}

/* ------------------------------------------------------------------ */
/* Small inline icons (kept local so no other file needs to change)    */
/* ------------------------------------------------------------------ */

function SvgIcon({ children, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const EyeIcon = () => (
  <SvgIcon>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </SvgIcon>
)

const EyeOffIcon = () => (
  <SvgIcon>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.7C3.9 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </SvgIcon>
)

const LockIcon = () => (
  <SvgIcon size={15}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </SvgIcon>
)

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)

const AlertIcon = () => (
  <SvgIcon size={16}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5M12 16v.01" />
  </SvgIcon>
)

/* ------------------------------------------------------------------ */
/* Counselling illustration                                            */
/* Original flat artwork drawn in SVG, built around what Kappiness is: */
/* two people talking, a coffee mug (like the logo) whose steam turns  */
/* into a heart, and bubbles for growth and care. To use a designer    */
/* illustration instead, save it in /public (for example               */
/* /public/login-illustration.png) and replace <WorkspaceArt /> below  */
/* with a next/image <Image />.                                        */
/* ------------------------------------------------------------------ */

const LEAF_PATH = 'M0 0 C -13 -26, -9 -54, 0 -74 C 9 -54, 13 -26, 0 0Z'

function Plant({ x, y, scale = 1 }) {
  const leaves = [
    { r: -50, s: 0.62, f: '#4a3027' },
    { r: -26, s: 0.9, f: '#8b9b7a' },
    { r: -3, s: 1, f: '#4a3027' },
    { r: 22, s: 0.86, f: '#8b9b7a' },
    { r: 46, s: 0.6, f: '#4a3027' },
  ]

  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      {leaves.map((l) => (
        <g key={l.r} transform={`translate(0 -4) rotate(${l.r}) scale(${l.s})`}>
          <path d={LEAF_PATH} fill={l.f} />
          <path d="M0 -4 C -1 -26 0 -46 0 -62" stroke="#f7f0e6" strokeOpacity="0.3" strokeWidth="1.6" fill="none" />
        </g>
      ))}
      <path d="M-26 0 H 26 L 21 70 H -21Z" fill="#f7f0e6" />
      <rect x="-30" y="-8" width="60" height="12" rx="5" fill="#ffffff" />
      <g fill="#b96f43">
        <circle cx="-10" cy="22" r="4" />
        <circle cx="8" cy="17" r="4" />
        <circle cx="0" cy="40" r="4" />
        <circle cx="14" cy="38" r="3.5" />
        <circle cx="-12" cy="52" r="3.5" />
      </g>
    </g>
  )
}

// One person seated in an armchair, facing right. The second person is the same
// group mirrored, with different clothes and hair.
function Seated({ chair, sweater, longHair = false, notebook = false }) {
  return (
    <g>
      {/* armchair */}
      <path d="M104 360 L 100 396 M 190 360 L 194 396" stroke="#2a1a14" strokeWidth="7" strokeLinecap="round" />
      <rect x="84" y="236" width="40" height="124" rx="18" fill={chair} transform="rotate(5 104 298)" />
      <rect x="92" y="330" width="112" height="32" rx="15" fill={chair} />
      <rect x="98" y="334" width="100" height="10" rx="5" fill="#ffffff" opacity="0.14" />

      {/* long hair sits behind the shoulders */}
      {longHair && (
        <path
          d="M134 200 C 128 170, 152 160, 170 172 C 182 182, 180 200, 176 214 C 174 244, 162 262, 138 266 C 126 250, 126 220, 134 200Z"
          fill="#2b1b15"
        />
      )}

      {/* legs */}
      <path d="M150 328 H 214" stroke="#2f1e17" strokeWidth="30" strokeLinecap="round" />
      <path d="M216 332 V 382" stroke="#2f1e17" strokeWidth="26" strokeLinecap="round" />
      <path d="M204 392 H 240 q5 0 5 -5 v-4 h-40 v6 q0 3 -1 3Z" fill="#f7f0e6" />

      {/* torso */}
      <path
        d="M128 246 C 120 276, 126 312, 138 334 L 186 334 C 192 296, 186 262, 170 246 C 158 236, 136 236, 128 246Z"
        fill={sweater}
      />
      <path d="M136 304 C 148 310, 170 310, 184 302" stroke="#000" strokeOpacity="0.1" strokeWidth="3" fill="none" strokeLinecap="round" />

      {/* neck and head */}
      <rect x="146" y="222" width="14" height="22" rx="7" fill="#d99b74" />
      <circle cx="152" cy="206" r="22" fill="#e8b08a" />
      <path
        d="M130 204 C 126 180, 150 172, 168 182 C 178 188, 178 198, 174 204 C 166 196, 146 194, 138 206 C 136 208, 131 208, 130 204Z"
        fill="#2b1b15"
      />
      {!longHair && <circle cx="134" cy="186" r="9" fill="#2b1b15" />}
      <circle cx="162" cy="208" r="2.2" fill="#2b1b15" />
      <path d="M160 217 q5 3 10 -1" stroke="#b9694a" strokeWidth="2.2" fill="none" strokeLinecap="round" />

      {/* arm and hand */}
      <path d="M164 256 C 176 272, 188 288, 194 304" stroke={sweater} strokeWidth="16" strokeLinecap="round" fill="none" />
      <circle cx="197" cy="307" r="8.5" fill="#e8b08a" />

      {notebook && (
        <g>
          <path d="M192 286 L 224 292 L 218 322 L 186 316Z" fill="#f7f0e6" stroke="#d7bf9c" strokeWidth="2" strokeLinejoin="round" />
          <path d="M196 296 L 214 299 M 195 303 L 212 306" stroke="#b96f43" strokeWidth="2" strokeLinecap="round" />
          <circle cx="197" cy="309" r="8.5" fill="#e8b08a" />
        </g>
      )}
    </g>
  )
}

function WorkspaceArt() {
  return (
    <svg
      className={styles.art}
      viewBox="0 0 560 420"
      role="img"
      aria-label="Illustration of two people talking in armchairs, with a coffee mug between them whose steam rises as a heart"
    >
      {/* backdrop shapes */}
      <path
        d="M30 330 C 6 220, 70 120, 170 96 C 262 74, 330 40, 410 70 C 500 104, 548 200, 530 290 C 518 356, 470 392, 380 396 L 90 396 C 56 392, 38 368, 30 330Z"
        fill="#e9c4a3"
      />
      <path
        d="M80 340 C 66 262, 120 196, 200 178 C 268 162, 340 134, 404 160 C 468 186, 504 246, 490 312 C 482 356, 444 388, 384 392 L 120 392 C 98 386, 86 366, 80 340Z"
        fill="#dba883"
      />

      {/* rug and floor */}
      <ellipse cx="280" cy="394" rx="238" ry="9" fill="#a85f35" opacity="0.45" />
      <path d="M24 396 H 540" stroke="#4a3027" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />

      {/* plants */}
      <Plant x={40} y={322} scale={0.92} />
      <Plant x={524} y={322} scale={0.92} />

      {/* the two people */}
      <Seated chair="#5d3f33" sweater="#8b9b7a" notebook />
      <g transform="translate(560 0) scale(-1 1)">
        <Seated chair="#7a4d3c" sweater="#f1e2cc" longHair />
      </g>

      {/* coffee table */}
      <rect x="276" y="338" width="8" height="52" rx="3" fill="#2a1a14" />
      <ellipse cx="280" cy="393" rx="24" ry="5" fill="#2a1a14" />
      <ellipse cx="280" cy="336" rx="36" ry="9" fill="#2a1a14" />
      <ellipse cx="280" cy="333" rx="36" ry="9" fill="#4a3027" />

      {/* the mug: swirl pattern nods to the Kappiness logo */}
      <path d="M294 312 q13 0 13 9 q0 9 -13 9" stroke="#ffffff" strokeWidth="5" fill="none" strokeLinecap="round" />
      <rect x="266" y="304" width="30" height="29" rx="8" fill="#ffffff" />
      <ellipse cx="281" cy="304" rx="15" ry="4" fill="#6b3f2a" />
      <path d="M272 318 c3 -5 7 3 10 -2 c3 -4 6 2 9 -1" stroke="#b96f43" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M272 325 c3 -4 7 2 10 -1 c3 -3 6 1 9 -1" stroke="#b96f43" strokeWidth="2.6" fill="none" strokeLinecap="round" />

      {/* steam rising into a heart */}
      <path d="M274 298 q-6 -10 0 -18 q6 -8 0 -16" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M288 298 q-6 -10 0 -18 q6 -8 0 -16" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path
        d="M281 262 C 246 240, 254 210, 268 210 C 276 210, 281 217, 281 221 C 281 217, 286 210, 294 210 C 308 210, 316 240, 281 262Z"
        fill="#ffffff"
      />
      <path
        d="M281 252 C 258 236, 262 220, 270 220 C 275 220, 281 226, 281 228 C 281 226, 287 220, 292 220 C 300 220, 304 236, 281 252Z"
        fill="#b96f43"
        opacity="0.9"
      />

      {/* speech bubbles: growth from the counsellor, care from the client */}
      <g>
        <rect x="110" y="112" width="66" height="44" rx="14" fill="#ffffff" />
        <path d="M138 156 l6 16 l14 -16Z" fill="#ffffff" />
        <path d="M143 142 V 128" stroke="#5f7352" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M143 132 C 135 130, 131 124, 133 120 C 140 119, 144 124, 143 132Z" fill="#8b9b7a" />
        <path d="M143 129 C 150 126, 156 121, 155 117 C 148 116, 143 121, 143 129Z" fill="#5f7352" />
        <rect x="160" y="130" width="10" height="4" rx="2" fill="#d9cfc6" />
      </g>
      <g>
        <rect x="394" y="96" width="70" height="46" rx="14" fill="#4a3027" />
        <path d="M420 142 l-4 16 l20 -16Z" fill="#4a3027" />
        <path
          d="M429 128 C 412 118, 416 104, 423 104 C 427 104, 429 108, 429 110 C 429 108, 432 104, 436 104 C 443 104, 446 118, 429 128Z"
          fill="#f7f0e6"
        />
      </g>

      {/* small sparkles and dots */}
      <g fill="#ffffff" opacity="0.85">
        <circle cx="64" cy="170" r="3" />
        <circle cx="500" cy="196" r="3.5" />
        <circle cx="198" cy="96" r="2.5" />
        <circle cx="480" cy="140" r="2.5" />
        <circle cx="330" cy="120" r="2.2" />
      </g>
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  function clearErrorsFor(field) {
    setError('')
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current))
  }

  async function handleLogin(event) {
    event.preventDefault()
    setError('')

    const problems = validate(email, password)
    setFieldErrors(problems)

    if (problems.email || problems.password) {
      document.getElementById(problems.email ? 'email' : 'password')?.focus()
      return
    }

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
      // On success the browser leaves for Google, so googleLoading stays true.
    } catch {
      setError('Something went wrong with Google sign-in.')
      setGoogleLoading(false)
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        {/* Left: colour panel. The illustration spills over onto the white side on wide screens. */}
        <section className={styles.welcome} aria-label="Welcome">
          <div className={styles.logoChip}>
            <Image
              src="/kappiness_logo_sq.jpeg"
              alt="Kappiness — Nourishing Minds, Pouring Happiness"
              width={180}
              height={100}
              priority
              className={styles.logo}
              style={{ width: 'auto', height: 'auto' }}
            />
          </div>

          <p className={styles.tagline}>Your workspace for meaningful connections and better care.</p>

          <div className={styles.artWrap}>
            <WorkspaceArt />
          </div>
        </section>

        {/* Right: sign-in form */}
        <section className={styles.formSide} aria-labelledby="login-title">
          <div className={styles.formWrap}>
            <h1 id="login-title" className={styles.title}>
              Sign in
            </h1>
            <p className={styles.subtitle}>Use your work email to open your workspace.</p>

            <form onSubmit={handleLogin} className={styles.form} noValidate>
              <div className={styles.field}>
                <label htmlFor="email" className={styles.label}>
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearErrorsFor('email')
                  }}
                  aria-invalid={fieldErrors.email ? 'true' : undefined}
                  aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                  className={styles.input}
                  placeholder="name@example.com"
                />
                {fieldErrors.email && (
                  <p id="email-error" role="alert" className={styles.fieldError}>
                    <AlertIcon /> {fieldErrors.email}
                  </p>
                )}
              </div>

              <div className={styles.field}>
                <label htmlFor="password" className={styles.label}>
                  Password
                </label>
                <div className={styles.control}>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      clearErrorsFor('password')
                    }}
                    aria-invalid={fieldErrors.password ? 'true' : undefined}
                    aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                    className={`${styles.input} ${styles.inputWithToggle}`}
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    className={styles.toggle}
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                {fieldErrors.password && (
                  <p id="password-error" role="alert" className={styles.fieldError}>
                    <AlertIcon /> {fieldErrors.password}
                  </p>
                )}
              </div>

              {error && (
                <p role="alert" className={styles.alert}>
                  <AlertIcon /> <span>{error}</span>
                </p>
              )}

              <button type="submit" disabled={loading || googleLoading} className={styles.submit}>
                {loading && <span className={styles.spinner} aria-hidden="true" />}
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>

            <div className={styles.divider}>
              <span>or continue with</span>
            </div>

            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={loading || googleLoading}
              className={styles.googleButton}
            >
              {googleLoading ? (
                <span className={`${styles.spinner} ${styles.spinnerDark}`} aria-hidden="true" />
              ) : (
                <GoogleIcon />
              )}
              {googleLoading ? 'Connecting to Google...' : 'Continue with Google'}
            </button>

            <p className={styles.footer}>
              <LockIcon /> Authorized team members only.
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}