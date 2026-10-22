
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

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
  const isAuthCallback =
  request.nextUrl.pathname === '/auth/callback'

  if (!isLoggedIn && !isLoginPage && !isAuthCallback) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''

    return NextResponse.redirect(url)
  }

  if (isLoggedIn && isLoginPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''

    return NextResponse.redirect(url)
  }

  return response
}



export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}


