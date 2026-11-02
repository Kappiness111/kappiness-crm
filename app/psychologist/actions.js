'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '../../utils/supabase/server'

function getTimeInMinutes(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a time in HH:MM format.`)
  }

  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value)
  if (!match) {
    throw new Error(`${fieldName} must be a time in HH:MM format.`)
  }

  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function validateAvailabilityInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Availability details are required.')
  }

  const dayOfWeek = Number(input.dayOfWeek)
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    throw new Error('Day of week must be an integer from 1 to 7.')
  }

  const startTime = input.startTime
  const endTime = input.endTime
  const startMinutes = getTimeInMinutes(startTime, 'Start time')
  const endMinutes = getTimeInMinutes(endTime, 'End time')

  if (endMinutes <= startMinutes) {
    throw new Error('End time must be later than start time.')
  }

  return {
    dayOfWeek,
    startTime: `${startTime}:00`,
    endTime: `${endTime}:00`,
  }
}

async function getAuthenticatedPsychologist() {
  const supabase = await createClient()
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError) {
    throw new Error('Unable to verify the signed-in user.')
  }

  if (!user) {
    redirect('/login')
  }

  const { data: psychologist, error: profileError } = await supabase
    .from('psychologists')
    .select('id, full_name, phone')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (profileError) {
    return { supabase, psychologist: null, profileError: true }
  }

  if (!psychologist) {
    return { supabase, psychologist: null, profileError: false }
  }

  return { supabase, psychologist, profileError: false }
}

function requirePsychologist(profile) {
  if (profile.profileError) {
    throw new Error('Could not load your profile.')
  }

  if (!profile.psychologist) {
    throw new Error('No psychologist profile is linked to this account.')
  }

  return profile
}

function throwWriteError(error, operation) {
  if (error?.code === '42501') {
    throw new Error(
      `${operation} is blocked by the current Supabase permissions. An approved RLS policy change is required.`
    )
  }

  throw new Error(`${operation} failed.`)
}

export async function getPsychologistData() {
  const { supabase, psychologist, profileError } =
    await getAuthenticatedPsychologist()

  if (profileError || !psychologist) {
    return {
      psychologist: null,
      availability: null,
      availabilityError: false,
      profileError,
    }
  }

  const { data: availability, error: availabilityError } = await supabase
    .from('psychologist_availability')
    .select('id, day_of_week, start_time, end_time')
    .eq('psychologist_id', psychologist.id)
    .eq('is_active', true)
    .order('day_of_week')
    .order('start_time')

  return {
    psychologist,
    availability,
    availabilityError: !!availabilityError,
    profileError: false,
  }
}

export async function addAvailability(input) {
  const profile = requirePsychologist(await getAuthenticatedPsychologist())
  const { supabase, psychologist } = profile
  const { dayOfWeek, startTime, endTime } = validateAvailabilityInput(input)
  const { error } = await supabase.from('psychologist_availability').insert({
    psychologist_id: psychologist.id,
    day_of_week: dayOfWeek,
    start_time: startTime,
    end_time: endTime,
    is_active: true,
  })

  if (error) {
    throwWriteError(error, 'Adding availability')
  }

  revalidatePath('/psychologist')
  return { success: true }
}

export async function setAvailabilityActive(availabilityId, isActive) {
  if (typeof availabilityId !== 'string' || !availabilityId.trim()) {
    throw new Error('An availability ID is required.')
  }

  if (typeof isActive !== 'boolean') {
    throw new Error('Availability status must be true or false.')
  }

  const profile = requirePsychologist(await getAuthenticatedPsychologist())
  const { supabase, psychologist } = profile
  const { error } = await supabase
    .from('psychologist_availability')
    .update({ is_active: isActive })
    .eq('id', availabilityId)
    .eq('psychologist_id', psychologist.id)
    .select('id')
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error('Availability was not found for this psychologist.')
    }
    throwWriteError(error, 'Updating availability')
  }

  revalidatePath('/psychologist')
  return { success: true }
}
