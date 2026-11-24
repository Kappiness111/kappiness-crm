This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel (Kappiness CRM)

The deployed app talks to Supabase directly from the browser and from Vercel. It never calls a local server.

**Environment variables** (Vercel → Project → Settings → Environment Variables; set for Production and Preview,
and in `.env.local` for local development; see `.env.example`):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API Keys / Data API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys → Publishable key (`sb_publishable_…`) |

Never add the secret / service_role key: `NEXT_PUBLIC_*` values are sent to the browser. After changing a variable,
redeploy (the values are built into the app).

**Supabase sign-in return addresses** (Supabase → Authentication → URL Configuration). Google sign-in returns to
`<site>/auth/callback`; Supabase only allows addresses on this list and otherwise falls back to the Site URL:

- Site URL: `https://kappiness-crm-rust.vercel.app`
- Redirect URLs: `https://kappiness-crm-rust.vercel.app/**`, `http://localhost:3000/**`, and your Vercel preview
  pattern (for example `https://kappiness-crm-*.vercel.app/**`).

If the Site URL is `http://localhost:3000` and the live address is missing from the list, signing in on the live site
sends people to localhost, which only works while a local dev server is running.
