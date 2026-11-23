
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { SupabaseConfigError, getSupabaseEnv } from './utils/supabase/env'

function preserveResponseState(source, target) {
  source.headers.forEach((value, key) => {
    if (key !== 'set-cookie') {
      target.headers.set(key, value)
    }
  })

  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie)
  })

  return target
}

export async function proxy(request) {
  let response = NextResponse.next({ request })

  // Without the Supabase settings no page can check the session, so stop with a clear message
  // (names of the missing variables only, never their values).
  let env
  try {
    env = getSupabaseEnv()
  } catch (error) {
    if (!(error instanceof SupabaseConfigError)) throw error
    console.error(error.message)
    return new NextResponse(error.message, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const supabase = createServerClient(
    env.url,
    env.key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value)
          })

          response = NextResponse.next({ request })

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })

          if (headers) {
            Object.entries(headers).forEach(([key, value]) => {
              response.headers.set(key, value)
            })
          }
        },
      },
    }
  )

  const { data, error } = await supabase.auth.getClaims()
  const claims = data?.claims

  const isLoggedIn = !error && !!claims
  const isLoginPage = request.nextUrl.pathname === '/login'
  const isAuthCallback =
  request.nextUrl.pathname === '/auth/callback'

  if (!isLoggedIn && !isLoginPage && !isAuthCallback) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''

    return preserveResponseState(response, NextResponse.redirect(url))
  }

  if (!isLoggedIn) {
    return response
  }

  if (typeof claims.sub !== 'string' || !claims.sub) {
    return preserveResponseState(
      response,
      NextResponse.json({ error: 'Unable to verify access.' }, { status: 500 })
    )
  }

  const { data: psychologist, error: profileError } = await supabase
    .from('psychologists')
    .select('id')
    .eq('auth_user_id', claims.sub)
    .maybeSingle()

  if (profileError) {
    return preserveResponseState(
      response,
      NextResponse.json({ error: 'Unable to verify access.' }, { status: 500 })
    )
  }

  const hasPsychologistProfile = !!psychologist
  const isPsychologistPage = request.nextUrl.pathname === '/psychologist'

  if (
    (hasPsychologistProfile && (!isPsychologistPage || isLoginPage)) ||
    (!hasPsychologistProfile && (isPsychologistPage || isLoginPage))
  ) {
    const url = request.nextUrl.clone()
    url.pathname = hasPsychologistProfile ? '/psychologist' : '/'
    url.search = ''

    return preserveResponseState(response, NextResponse.redirect(url))
  }

  return response
}



export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

