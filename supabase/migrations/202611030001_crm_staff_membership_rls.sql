
-- Kappiness CRM: trusted staff membership and lead-data authorization
-- Captures the staff membership and RLS changes already applied
-- to the live Supabase project.

BEGIN;

-- 1. Create the trusted CRM staff membership table.
CREATE TABLE public.crm_staff_members (
    user_id uuid PRIMARY KEY
        REFERENCES auth.users(id) ON DELETE CASCADE,
    access_level text NOT NULL DEFAULT 'staff'
        CHECK (access_level IN ('staff', 'admin')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid
        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 2. Index the creator foreign key.
CREATE INDEX idx_crm_staff_members_created_by
    ON public.crm_staff_members(created_by);

-- 3. Restrict access to the membership table.
ALTER TABLE public.crm_staff_members
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.crm_staff_members
    FROM anon, authenticated;

GRANT SELECT ON TABLE public.crm_staff_members
    TO authenticated;

GRANT ALL ON TABLE public.crm_staff_members
    TO service_role;

-- 4. Staff can read only their own active membership.
CREATE POLICY "Users can view their own active CRM staff membership"
ON public.crm_staff_members
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    AND is_active = true
);

-- 5. Require active staff membership to access leads.
CREATE POLICY "Require active CRM staff membership"
ON public.leads
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.crm_staff_members AS m
        WHERE m.user_id = (SELECT auth.uid())
          AND m.is_active = true
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.crm_staff_members AS m
        WHERE m.user_id = (SELECT auth.uid())
          AND m.is_active = true
    )
);

-- 6. Require active staff membership to access lead activities.
CREATE POLICY "Require active CRM staff membership"
ON public.lead_activities
AS RESTRICTIVE
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.crm_staff_members AS m
        WHERE m.user_id = (SELECT auth.uid())
          AND m.is_active = true
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.crm_staff_members AS m
        WHERE m.user_id = (SELECT auth.uid())
          AND m.is_active = true
    )
);

COMMIT;
