
'use client'

import { useState } from 'react'
import { createClient } from '../../utils/supabase/client'

export default function RLSTestPage() {
  const [running, setRunning] = useState(false)
  const [anonymousRunning, setAnonymousRunning] = useState(false)
  const [results, setResults] = useState([])
  const [anonymousResults, setAnonymousResults] = useState([])
  const [error, setError] = useState('')

  async function runTests() {
    setRunning(true)
    setResults([])
    setError('')

    const checks = []
    const supabase = createClient()

    try {
      // Confirm the browser has a valid staff session.
      const {
        data: sessionData,
        error: sessionError,
      } = await supabase.auth.getSession()

      if (sessionError || !sessionData.session) {
        throw new Error('No active session. Please sign in again.')
      }

      checks.push('PASS: Signed-in session found.')

      // Test reading leads.
      const { data: leads, error: readError } = await supabase
        .from('leads')
        .select('id, lead_code, full_name')
        .limit(5)

      if (readError) throw readError

      checks.push(
        `PASS: Read leads successfully (${leads.length} returned).`
      )

      // Create a clearly marked test lead.
      const { data: newLead, error: insertError } = await supabase
        .from('leads')
        .insert({
          full_name: 'RLS TEST - DELETE MANUALLY LATER',
          phone: '0000000000',
          source: 'RLS Permission Test',
          status: 'New',
          notes: 'Temporary test record. Not a real enquiry.',
        })
        .select('id, lead_code, full_name')
        .single()

      if (insertError) throw insertError

      checks.push(
        `PASS: Created test lead ${newLead.lead_code || newLead.id}.`
      )

      // Read back the created lead.
      const { data: savedLead, error: verifyLeadError } = await supabase
        .from('leads')
        .select('id, lead_code, full_name')
        .eq('id', newLead.id)
        .single()

      if (verifyLeadError) throw verifyLeadError

      checks.push(`PASS: Read back test lead ${savedLead.id}.`)

      // Create an activity linked to the test lead.
      const { data: activity, error: activityInsertError } =
        await supabase
          .from('lead_activities')
          .insert({
            lead_id: newLead.id,
            activity_type: 'RLS Test',
            notes: 'Temporary database permissions test.',
            outcome: 'Test record created',
          })
          .select('id, lead_id, activity_type')
          .single()

      if (activityInsertError) throw activityInsertError

      checks.push(`PASS: Created activity ${activity.id}.`)

      // Read back the linked activity.
      const { data: savedActivities, error: activityReadError } =
        await supabase
          .from('lead_activities')
          .select('id, lead_id, activity_type')
          .eq('lead_id', newLead.id)

      if (activityReadError) throw activityReadError

      if (!savedActivities.some((item) => item.id === activity.id)) {
        throw new Error('Activity was created but could not be read back.')
      }

      checks.push('PASS: Read back the linked activity.')
      checks.push(
        `NOTE: Test lead ID: ${newLead.id}. Keep this ID for cleanup later.`
      )
    } catch (err) {
      setError(err.message || 'An unexpected test error occurred.')
    } finally {
      setResults(checks)
      setRunning(false)
    }
  }

  async function testAnonymousAccess() {
    setAnonymousRunning(true)
    setAnonymousResults([])

    try {
      // Create a separate client with no staff session.
      const anonymousClient = createClient()

      const {
        data: { session },
        error: sessionError,
      } = await anonymousClient.auth.getSession()

      if (sessionError) {
        throw new Error(
          `Could not check the anonymous session: ${sessionError.message}`
        )
      }

      if (session) {
        setAnonymousResults([
          'NOT TESTED: This client has an active session. Sign out in a separate private browser window and retry.',
        ])
        return
      }

      const checks = []

      for (const table of ['leads', 'lead_activities']) {
        const { data, error: queryError } = await anonymousClient
          .from(table)
          .select('*')
          .limit(1)

        if (queryError) {
          checks.push(
            `PASS: ${table} access denied (${queryError.code || queryError.message}).`
          )
        } else if (data?.length === 0) {
          checks.push(
            `INCONCLUSIVE: ${table} returned zero rows; denial is not proven.`
          )
        } else {
          checks.push(
            `FAIL: Anonymous client received data from ${table}.`
          )
        }
      }

      setAnonymousResults(checks)
    } catch (err) {
      setAnonymousResults([
        `Test error: ${err.message || 'Unexpected error.'}`,
      ])
    } finally {
      setAnonymousRunning(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-bold">
        Kappiness CRM — RLS Test
      </h1>

      <p className="mt-3 text-gray-600">
        Authenticated tests create a clearly marked test lead and linked
        activity. They do not delete or update existing records.
      </p>

      <button
        onClick={runTests}
        disabled={running || anonymousRunning}
        className="mt-6 rounded-lg bg-purple-700 px-5 py-3 font-semibold text-white disabled:opacity-60"
      >
        {running ? 'Running tests...' : 'Run authenticated tests'}
      </button>

      {results.length > 0 && (
        <ul className="mt-6 list-disc space-y-2 pl-5">
          {results.map((result, index) => (
            <li key={index} className="break-words">
              {result}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-5 break-words text-red-700">
          Test stopped: {error}
        </p>
      )}

      <hr className="my-8" />

      <h2 className="text-xl font-semibold">
        Anonymous access check
      </h2>

      <p className="mt-2 text-gray-600">
        This test checks whether a client without a signed-in session
        can query either table.
      </p>

      <button
        onClick={testAnonymousAccess}
        disabled={running || anonymousRunning}
        className="mt-4 rounded-lg border border-gray-300 px-5 py-3 font-semibold disabled:opacity-60"
      >
        {anonymousRunning
          ? 'Checking access...'
          : 'Test anonymous access'}
      </button>

      {anonymousResults.length > 0 && (
        <ul className="mt-5 list-disc space-y-2 pl-5">
          {anonymousResults.map((result, index) => (
            <li key={index} className="break-words">
              {result}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
