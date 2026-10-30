import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { createClient } from '../../utils/supabase/server'
import { getPsychologistData } from './actions'

const DAYS = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
}

async function signOutAction() {
  'use server'

  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

async function PsychologistContent() {
  await connection()

  const { psychologist, availability, availabilityError, profileError } =
    await getPsychologistData()

  if (profileError) {
    return <main><h1>Could not load your profile</h1></main>
  }

  if (!psychologist) {
    return (
      <main>
        <h1>No psychologist profile linked</h1>
        <p>Ask an admin to link your login to your psychologist profile.</p>
      </main>
    )
  }

  return (
    <main>
      <h1>Welcome, {psychologist.full_name}</h1>
      {psychologist.phone && <p>Phone: {psychologist.phone}</p>}

      <h2>Regular availability</h2>

      {availabilityError ? (
        <p>Could not load availability.</p>
      ) : availability?.length ? (
        <ul>
          {availability.map((slot, index) => (
            <li key={`${slot.day_of_week}-${slot.start_time}-${index}`}>
              {DAYS[slot.day_of_week]}: {slot.start_time.slice(0, 5)}–
              {slot.end_time.slice(0, 5)}
            </li>
          ))}
        </ul>
      ) : (
        <p>No active availability has been added yet.</p>
      )}

      <form action={signOutAction}>
        <button
          type="submit"
          style={{
            position: 'fixed',
            bottom: '16px',
            left: '16px',
            padding: '8px 14px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            background: '#ffffff',
            color: '#111827',
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </form>
    </main>
  )
}

export default function PsychologistPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <PsychologistContent />
    </Suspense>
  )
}