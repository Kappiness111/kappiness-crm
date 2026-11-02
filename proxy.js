
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
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

  if (!isLoggedIn && !isLoginPage) {
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

