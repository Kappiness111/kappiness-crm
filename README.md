# Kappiness CRM

Internal CRM application developed for Kappiness Mental Health and Therapeutic Centre to manage clinic operations, leads, clients, appointments, psychologist availability, follow-ups and therapy sessions.

## Overview

Kappiness CRM centralizes the clinic's administrative workflows into a single web application. It helps the reception and administrative team manage enquiries, coordinate appointments, track patient follow-ups and monitor psychologist schedules.

## Tech Stack

- **Frontend:** Next.js 16, React 19, JavaScript
- **Styling:** Tailwind CSS 4, CSS Modules
- **Backend:** Supabase
- **Authentication:** Supabase Auth
- **Database:** Supabase PostgreSQL
- **Deployment:** Vercel
- **Code Quality:** ESLint

## Core Modules

### Dashboard
- Daily lead and follow-up overview
- Leads requiring confirmation calls
- Psychologist availability
- Recommended sessions
- Appointment overview and timeline
- Follow-up reminders and recent activity

### Lead Management
- Lead tracking and status management
- Lead follow-up calls
- Enquiry management
- Lead pipeline monitoring

### Client Management
- Client records and profiles
- Client search by name or phone number
- Client-related appointment information

### Appointment Management
- Appointment scheduling
- Client selection
- Available, tentative and booked slots
- Appointment tracking

### Availability & Leave
- Psychologist schedules
- Daily slot availability
- Booked versus available capacity
- Leave and availability tracking

### Follow-ups & Notifications
- Follow-up reminders
- Due reminder tracking
- Reminder delivery records
- Recent activity

### Session Management
- Therapy session records
- Session tracking and management

## Project Structure

```text
kappiness-crm/
│
├── app/
│   ├── components/
│   │   ├── dashboard/
│   │   ├── help/
│   │   ├── notifications/
│   │   ├── schedule/
│   │   └── ui/
│   │
│   ├── lib/
│   ├── login/
│   ├── schedule/
│   ├── layout.js
│   ├── page.js
│   └── globals.css
│
├── public/
├── scripts/
├── supabase/
├── tests/
├── utils/
│   └── supabase/
│
├── .env.example
├── package.json
└── README.md
```

## Local Development Setup

### Prerequisites
- Node.js
- npm
- Git
- Supabase project credentials

### Installation

```bash
git clone https://github.com/Kappiness111/kappiness-crm.git

cd kappiness-crm

npm install
```

### Environment Configuration

Create a `.env.local` file in the project root and configure the required Supabase credentials.

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

Use the actual project credentials. Never commit `.env.local` or secret keys.

### Run Development Server

```bash
npm run dev
```

Application runs at:

`http://localhost:3000`

## Available Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Create production build |
| `npm run start` | Run production server |
| `npm run lint` | Run ESLint |

## Development Notes

- Follow the existing component structure when adding new features.
- Reuse shared UI components wherever possible.
- Keep Supabase queries and business logic organized within the library structure.
- Maintain consistency across dashboard, scheduling and booking modules.
- Test responsive layouts in desktop, tablet and mobile views.
- Verify changes in both light and dark themes.
- Follow existing database security policies and authentication patterns.
- Do not commit patient data, credentials or environment files.

## Deployment

The application is deployed through Vercel.

Deployment environment variables must be configured in the Vercel project settings.

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
