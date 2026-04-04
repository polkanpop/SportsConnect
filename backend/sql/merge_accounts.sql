-- ================================================================
-- merge_accounts(p_primary_userid, p_secondary_userid)
-- ================================================================
-- Atomically merges the SECONDARY account into the PRIMARY account.
-- Called from POST /api/auth/link-zalo when the Zalo ID being linked
-- is already associated with a different (phantom) account.
--
-- Rules (per spec Part 3 + 4):
--   * PRIMARY always wins for name, email, pfp.
--   * NULL fields on primary are back-filled from secondary.
--   * Verification flags take the most-favorable value (OR).
--   * favouritecourts: deduplicated (keep primary's row on conflict).
--   * user_auth_providers: deduplicated (keep primary's on conflict).
--   * block_list: self-blocks removed after migration.
--   * All booking history remains (no deduplication of bookings).
--   * Secondary users row is deleted LAST after all FKs are migrated.
--
-- Run once in Supabase SQL editor to create the function.
-- ================================================================

CREATE OR REPLACE FUNCTION public.merge_accounts(
    p_primary_userid   INTEGER,
    p_secondary_userid INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_primary_info     RECORD;
    v_secondary_info   RECORD;
    v_primary_unver    RECORD;
    v_secondary_unver  RECORD;
    v_copy_phone       VARCHAR;
    v_copy_email       TEXT;
BEGIN
    -- ── Guard ───────────────────────────────────────────────────────────────
    IF p_primary_userid IS NULL OR p_secondary_userid IS NULL THEN
        RAISE EXCEPTION 'Both userids must be non-null' USING ERRCODE = 'P0001';
    END IF;

    IF p_primary_userid = p_secondary_userid THEN
        RETURN jsonb_build_object('ok', true, 'message', 'same_account');
    END IF;

    -- Verify both users exist
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE userid = p_primary_userid) THEN
        RAISE EXCEPTION 'Primary user % not found', p_primary_userid USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE userid = p_secondary_userid) THEN
        RAISE EXCEPTION 'Secondary user % not found', p_secondary_userid USING ERRCODE = 'P0001';
    END IF;

    -- ── Snapshot userinfo and unverified rows before any mutations ──────────
    SELECT * INTO v_primary_info   FROM public.userinfo WHERE userid = p_primary_userid  LIMIT 1;
    SELECT * INTO v_secondary_info FROM public.userinfo WHERE userid = p_secondary_userid LIMIT 1;

    SELECT * INTO v_primary_unver   FROM public.unverified_users WHERE userid = p_primary_userid  LIMIT 1;
    SELECT * INTO v_secondary_unver FROM public.unverified_users WHERE userid = p_secondary_userid LIMIT 1;

    -- ── 1. Court bookings ───────────────────────────────────────────────────
    UPDATE public.courtbooking
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 2. Event bookings ───────────────────────────────────────────────────
    UPDATE public.eventbooking
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 3. Training session bookings ────────────────────────────────────────
    UPDATE public.tsbookings
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 4. Favourite courts (deduplicate: skip if primary already has it) ───
    UPDATE public.favouritecourts fc
    SET userid = p_primary_userid
    WHERE fc.userid = p_secondary_userid
      AND NOT EXISTS (
          SELECT 1 FROM public.favouritecourts fc2
          WHERE fc2.userid = p_primary_userid AND fc2.courtid = fc.courtid
      );
    -- Remove any remaining secondary duplicates
    DELETE FROM public.favouritecourts WHERE userid = p_secondary_userid;

    -- ── 5. Reviews ──────────────────────────────────────────────────────────
    UPDATE public.reviews
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 6. Review reactions ─────────────────────────────────────────────────
    UPDATE public.review_reactions
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 7. Notifications ────────────────────────────────────────────────────
    UPDATE public.notifications
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 8. User devices ─────────────────────────────────────────────────────
    UPDATE public.user_devices
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 9. User tokens ──────────────────────────────────────────────────────
    UPDATE public.user_tokens
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 10. Block list ──────────────────────────────────────────────────────
    UPDATE public.block_list
    SET blocked_userid = p_primary_userid
    WHERE blocked_userid = p_secondary_userid;

    UPDATE public.block_list
    SET blocked_by_userid = p_primary_userid
    WHERE blocked_by_userid = p_secondary_userid;

    -- Remove self-blocks created by migration
    DELETE FROM public.block_list
    WHERE blocked_userid = blocked_by_userid;

    -- ── 11. Auth providers (deduplicate: keep primary's on provider conflict) 
    UPDATE public.user_auth_providers
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid
      AND NOT EXISTS (
          SELECT 1 FROM public.user_auth_providers ap2
          WHERE ap2.userid = p_primary_userid
            AND ap2.provider = user_auth_providers.provider
      );
    -- Remove any remaining secondary duplicates (primary's row was kept)
    DELETE FROM public.user_auth_providers WHERE userid = p_secondary_userid;

    -- ── 12. Userlogin rows ──────────────────────────────────────────────────
    UPDATE public.userlogin
    SET userid = p_primary_userid
    WHERE userid = p_secondary_userid;

    -- ── 13. Migrate courts/events/sessions owned by secondary (FK safety) ───
    UPDATE public.courts
    SET ownerid = p_primary_userid
    WHERE ownerid = p_secondary_userid;

    UPDATE public.events
    SET organizerid = p_primary_userid
    WHERE organizerid = p_secondary_userid;

    UPDATE public.trainingsessions
    SET coachid = p_primary_userid
    WHERE coachid = p_secondary_userid;

    -- ── 14. Unverified_users merge ──────────────────────────────────────────
    IF v_secondary_unver IS NOT NULL THEN
        IF v_primary_unver IS NOT NULL THEN
            -- Determine values to copy (only if primary has NULL, safely releasing
            -- the UNIQUE constraint on secondary first to avoid conflicts).
            v_copy_phone := CASE
                WHEN v_primary_unver.phone IS NULL THEN v_secondary_unver.phone
                ELSE NULL
            END;
            v_copy_email := CASE
                WHEN v_primary_unver.email IS NULL THEN v_secondary_unver.email
                ELSE NULL
            END;

            -- Release secondary unique values before updating primary
            IF v_copy_phone IS NOT NULL THEN
                UPDATE public.unverified_users SET phone = NULL WHERE userid = p_secondary_userid;
            END IF;
            IF v_copy_email IS NOT NULL THEN
                UPDATE public.unverified_users SET email = NULL WHERE userid = p_secondary_userid;
            END IF;

            -- Merge into primary: fill nulls + take most favorable verification flags
            UPDATE public.unverified_users SET
                phone        = COALESCE(phone, v_copy_phone),
                email        = COALESCE(email, v_copy_email),
                email_verified = (email_verified OR v_secondary_unver.email_verified),
                phone_verified = (phone_verified OR v_secondary_unver.phone_verified)
            WHERE userid = p_primary_userid;

            -- Delete secondary row
            DELETE FROM public.unverified_users WHERE userid = p_secondary_userid;
        ELSE
            -- Primary has no unverified row → just reassign secondary's row
            UPDATE public.unverified_users SET userid = p_primary_userid WHERE userid = p_secondary_userid;
        END IF;
    END IF;

    -- ── 15. Userinfo merge (primary wins; only fill nulls from secondary) ───
    IF v_primary_info IS NOT NULL AND v_secondary_info IS NOT NULL THEN
        UPDATE public.userinfo SET
            contactnumber = COALESCE(contactnumber, v_secondary_info.contactnumber)
            -- name, email, pfp: primary always wins — no update needed
        WHERE userid = p_primary_userid;
        DELETE FROM public.userinfo WHERE userid = p_secondary_userid;
    ELSIF v_secondary_info IS NOT NULL THEN
        -- No primary userinfo row (unusual) — migrate secondary's row
        UPDATE public.userinfo SET userid = p_primary_userid WHERE userid = p_secondary_userid;
    END IF;

    -- ── 16. Delete secondary users row (last — all FKs now migrated) ────────
    DELETE FROM public.users WHERE userid = p_secondary_userid;

    RETURN jsonb_build_object(
        'ok',               true,
        'primary_userid',   p_primary_userid,
        'secondary_userid', p_secondary_userid
    );

EXCEPTION WHEN OTHERS THEN
    -- Any error rolls back the entire transaction automatically (plpgsql default)
    RAISE EXCEPTION 'merge_accounts failed: % (SQLSTATE: %)', SQLERRM, SQLSTATE
        USING ERRCODE = SQLSTATE;
END;
$$;
