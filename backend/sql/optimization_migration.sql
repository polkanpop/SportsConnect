-- =============================================================================
-- MIGRATION: Reviews & Voting | FK Indexes | Special Indexes | Booking RPC
-- =============================================================================
-- Run this in the Supabase SQL editor (or psql).
-- Fully re-runnable: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- SECTIONS
--   1. Reviews & Voting   (logic ready — hidden from frontend until release)
--   2. Foreign-Key Indexes
--   3. Special Indexes    (GIN · B-Tree · Partial · Map)
--   4. Booking RPC        (race-condition safe with FOR UPDATE row lock)
-- =============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1 · REVIEWS & VOTING
-- ============================================================================
-- STATUS: complete backend logic.  NOT YET WIRED TO FRONTEND.
-- To expose: uncomment the GRANT lines at the bottom of this section and
-- register the two RPCs ( rpc_create_review / rpc_upsert_review_reaction )
-- in your backendApi.ts.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1-A  Add denormalised like / dislike counters to reviews
--      These avoid an aggregate query on review_reactions every time a list
--      is rendered; they are kept consistent by the trigger in 1-D.
-- --------------------------------------------------------------------------
ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS like_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dislike_count integer NOT NULL DEFAULT 0;

-- Ensure the unique-per-user constraint exists on review_reactions
-- (table was created in reviews_notifications_migration.sql but the
--  UNIQUE constraint may have been added separately)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint c
    JOIN   pg_class t   ON t.oid = c.conrelid
    JOIN   pg_namespace n ON n.oid = t.relnamespace
    WHERE  n.nspname   = 'public'
      AND  t.relname   = 'review_reactions'
      AND  c.contype   = 'u'
  ) THEN
    ALTER TABLE public.review_reactions
      ADD CONSTRAINT review_reactions_reviewid_userid_key UNIQUE (reviewid, userid);
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1-B  Helper: has_completed_booking
--      Returns TRUE when the given user has at least one completed session
--      for the requested target (court / event / trainingsession).
--      Used as the eligibility gate inside every review / reaction RPC.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_completed_booking(
  p_userid     int,
  p_targettype public.reviewtargettype,
  p_targetid   int
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN CASE p_targettype

    -- A user may review a court if they completed a court booking for it.
    WHEN 'court' THEN EXISTS (
      SELECT 1
      FROM   courtbooking  cb
      JOIN   courtavailability ca ON ca.availabilityid = cb.availabilityid
      WHERE  cb.userid        = p_userid
        AND  ca.courtid       = p_targetid
        AND  cb.bookingstatus = 'completed'::sessionstatus
    )

    -- A user may review an event if they joined and its session completed.
    WHEN 'event' THEN EXISTS (
      SELECT 1
      FROM   eventbooking eb
      WHERE  eb.userid        = p_userid
        AND  eb.eventid       = p_targetid
        AND  eb.bookingstatus = 'completed'::sessionstatus
    )

    -- A user may review a training session if their attendance completed.
    WHEN 'trainingsession' THEN EXISTS (
      SELECT 1
      FROM   tsbookings tb
      WHERE  tb.userid        = p_userid
        AND  tb.sessionid     = p_targetid
        AND  tb.bookingstatus = 'completed'::sessionstatus
    )

    ELSE FALSE
  END;
END;
$$;

-- --------------------------------------------------------------------------
-- 1-C  RPC: rpc_create_review
--      Creates a new review or updates an existing one (one review per user
--      per target enforced here).  Blocked unless eligibility passes.
--
--      Returns:  reviewid  – the (new or updated) review id
--                created   – true on INSERT, false on UPDATE
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_review(
  p_userid     int,
  p_targettype public.reviewtargettype,
  p_targetid   int,
  p_rating     int,
  p_comment    text
)
RETURNS TABLE (reviewid int, created bool)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id int;
  v_new_id      int;
BEGIN
  -- ── Eligibility gate ──────────────────────────────────────────────────
  IF NOT public.has_completed_booking(p_userid, p_targettype, p_targetid) THEN
    RAISE EXCEPTION
      'REVIEW_NOT_ELIGIBLE: user % has no completed booking for % id=%',
      p_userid, p_targettype, p_targetid
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Rating range guard ────────────────────────────────────────────────
  IF p_rating < 1 OR p_rating > 5 THEN
    RAISE EXCEPTION 'INVALID_RATING: must be 1–5, got %', p_rating
      USING ERRCODE = 'P0002';
  END IF;

  -- ── One review per user per target ────────────────────────────────────
  SELECT r.reviewid
  INTO   v_existing_id
  FROM   public.reviews r
  WHERE  r.userid     = p_userid
    AND  r.targettype = p_targettype
    AND  r.targetid   = p_targetid;

  IF v_existing_id IS NOT NULL THEN
    -- Update path
    UPDATE public.reviews
    SET    rating     = p_rating,
           comment   = p_comment,
           updated_at = now()
    WHERE  public.reviews.reviewid = v_existing_id;

    RETURN QUERY SELECT v_existing_id, false;
  ELSE
    -- Insert path
    INSERT INTO public.reviews (rating, comment, targettype, targetid, userid)
    VALUES (p_rating, p_comment, p_targettype, p_targetid, p_userid)
    RETURNING public.reviews.reviewid INTO v_new_id;

    RETURN QUERY SELECT v_new_id, true;
  END IF;
END;
$$;

-- --------------------------------------------------------------------------
-- 1-D  RPC: rpc_upsert_review_reaction
--      Lets an eligible user cast or change a like/dislike on any review.
--      Pass p_reaction = NULL to retract an existing reaction.
--      Denormalised counters on reviews are updated atomically here.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_upsert_review_reaction(
  p_userid   int,
  p_reviewid int,
  p_reaction public.review_reaction_type  -- 'like' | 'dislike' | NULL to remove
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_targettype   public.reviewtargettype;
  v_targetid     int;
  v_old_reaction public.review_reaction_type;
BEGIN
  -- ── Fetch the review's target ────────────────────────────────────────
  SELECT r.targettype, r.targetid
  INTO   v_targettype, v_targetid
  FROM   public.reviews r
  WHERE  r.reviewid = p_reviewid
  FOR SHARE;  -- lightweight read-lock; prevents concurrent DELETE of the review

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_NOT_FOUND: reviewid %', p_reviewid
      USING ERRCODE = 'P0003';
  END IF;

  -- ── Eligibility gate ──────────────────────────────────────────────────
  IF NOT public.has_completed_booking(p_userid, v_targettype, v_targetid) THEN
    RAISE EXCEPTION
      'REACTION_NOT_ELIGIBLE: user % has no completed booking for % id=%',
      p_userid, v_targettype, v_targetid
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Fetch the user's current reaction (if any) ────────────────────────
  SELECT rr.reaction
  INTO   v_old_reaction
  FROM   public.review_reactions rr
  WHERE  rr.reviewid = p_reviewid
    AND  rr.userid   = p_userid;

  -- ── Apply the change ──────────────────────────────────────────────────
  IF p_reaction IS NULL THEN
    -- Remove reaction
    DELETE FROM public.review_reactions
    WHERE  reviewid = p_reviewid AND userid = p_userid;

    -- Roll back the old counter
    IF v_old_reaction = 'like' THEN
      UPDATE public.reviews
      SET    like_count    = GREATEST(0, like_count    - 1)
      WHERE  public.reviews.reviewid = p_reviewid;
    ELSIF v_old_reaction = 'dislike' THEN
      UPDATE public.reviews
      SET    dislike_count = GREATEST(0, dislike_count - 1)
      WHERE  public.reviews.reviewid = p_reviewid;
    END IF;

  ELSE
    -- Upsert reaction (ON CONFLICT handles the unique(reviewid,userid) key)
    INSERT INTO public.review_reactions (reviewid, userid, reaction)
    VALUES (p_reviewid, p_userid, p_reaction)
    ON CONFLICT (reviewid, userid)
    DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now();

    -- Only touch the counters when the reaction value actually changed
    IF v_old_reaction IS DISTINCT FROM p_reaction THEN

      -- Roll back old counter
      IF v_old_reaction = 'like' THEN
        UPDATE public.reviews
        SET    like_count    = GREATEST(0, like_count    - 1)
        WHERE  public.reviews.reviewid = p_reviewid;
      ELSIF v_old_reaction = 'dislike' THEN
        UPDATE public.reviews
        SET    dislike_count = GREATEST(0, dislike_count - 1)
        WHERE  public.reviews.reviewid = p_reviewid;
      END IF;

      -- Increment new counter
      IF p_reaction = 'like' THEN
        UPDATE public.reviews
        SET    like_count    = like_count    + 1
        WHERE  public.reviews.reviewid = p_reviewid;
      ELSIF p_reaction = 'dislike' THEN
        UPDATE public.reviews
        SET    dislike_count = dislike_count + 1
        WHERE  public.reviews.reviewid = p_reviewid;
      END IF;

    END IF;
  END IF;
END;
$$;

-- --------------------------------------------------------------------------
-- 1-E  Trigger: _sync_review_reaction_counts
--      Belt-and-suspenders guard: keeps like/dislike counters correct even
--      if a row is written directly to review_reactions (e.g. admin scripts).
--      The RPCs above are the primary write path and do their own accounting,
--      so this trigger only fires for out-of-band writes.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._sync_review_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reaction = 'like' THEN
      UPDATE public.reviews SET like_count    = like_count    + 1 WHERE reviewid = NEW.reviewid;
    ELSIF NEW.reaction = 'dislike' THEN
      UPDATE public.reviews SET dislike_count = dislike_count + 1 WHERE reviewid = NEW.reviewid;
    END IF;

  ELSIF TG_OP = 'UPDATE' AND OLD.reaction IS DISTINCT FROM NEW.reaction THEN
    -- Roll back old
    IF OLD.reaction = 'like' THEN
      UPDATE public.reviews SET like_count    = GREATEST(0, like_count    - 1) WHERE reviewid = NEW.reviewid;
    ELSIF OLD.reaction = 'dislike' THEN
      UPDATE public.reviews SET dislike_count = GREATEST(0, dislike_count - 1) WHERE reviewid = NEW.reviewid;
    END IF;
    -- Apply new
    IF NEW.reaction = 'like' THEN
      UPDATE public.reviews SET like_count    = like_count    + 1 WHERE reviewid = NEW.reviewid;
    ELSIF NEW.reaction = 'dislike' THEN
      UPDATE public.reviews SET dislike_count = dislike_count + 1 WHERE reviewid = NEW.reviewid;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.reaction = 'like' THEN
      UPDATE public.reviews SET like_count    = GREATEST(0, like_count    - 1) WHERE reviewid = OLD.reviewid;
    ELSIF OLD.reaction = 'dislike' THEN
      UPDATE public.reviews SET dislike_count = GREATEST(0, dislike_count - 1) WHERE reviewid = OLD.reviewid;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_review_reaction_counts ON public.review_reactions;
CREATE TRIGGER trg_review_reaction_counts
AFTER INSERT OR UPDATE OR DELETE ON public.review_reactions
FOR EACH ROW EXECUTE FUNCTION public._sync_review_reaction_counts();

-- --------------------------------------------------------------------------
-- 1-F  GRANTs (uncomment when you are ready to expose reviews to the frontend)
-- --------------------------------------------------------------------------
-- GRANT EXECUTE ON FUNCTION public.rpc_create_review            TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.rpc_upsert_review_reaction   TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.has_completed_booking        TO authenticated;


-- ============================================================================
-- SECTION 2 · FOREIGN-KEY INDEXES
-- ============================================================================
-- Every FK column that lacks a supporting index causes Postgres to perform a
-- sequential scan on the referencing table when the parent row is JOINed,
-- UPDATEd, or DELETEd.  These are all additive (IF NOT EXISTS) and safe to
-- apply to a live database.
-- ============================================================================

-- ── block_list ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_block_list_blocked_userid
  ON public.block_list (blocked_userid);
CREATE INDEX IF NOT EXISTS idx_block_list_blocked_by_userid
  ON public.block_list (blocked_by_userid);

-- ── courtavailability ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courtavailability_courtid
  ON public.courtavailability (courtid);
CREATE INDEX IF NOT EXISTS idx_courtavailability_playingcourtid
  ON public.courtavailability (playingcourtid);

-- ── courtbooking ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courtbooking_availabilityid
  ON public.courtbooking (availabilityid);
CREATE INDEX IF NOT EXISTS idx_courtbooking_userid
  ON public.courtbooking (userid);
CREATE INDEX IF NOT EXISTS idx_courtbooking_paymentid
  ON public.courtbooking (paymentid);
CREATE INDEX IF NOT EXISTS idx_courtbooking_playingcourtid
  ON public.courtbooking (playingcourtid);

-- ── courtinfo ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courtinfo_courtid
  ON public.courtinfo (courtid);

-- ── courts ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courts_ownerid
  ON public.courts (ownerid);

-- ── eventbooking ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_eventbooking_eventid
  ON public.eventbooking (eventid);
CREATE INDEX IF NOT EXISTS idx_eventbooking_userid
  ON public.eventbooking (userid);
CREATE INDEX IF NOT EXISTS idx_eventbooking_paymentid
  ON public.eventbooking (paymentid);

-- ── eventinfo ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_eventinfo_eventid
  ON public.eventinfo (eventid);

-- ── events ───────────────────────────────────────────────────────────────────
-- courtbookingid already has a UNIQUE constraint (which creates an index).
CREATE INDEX IF NOT EXISTS idx_events_organizerid
  ON public.events (organizerid);

-- ── favouritecourts ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_favouritecourts_userid
  ON public.favouritecourts (userid);
CREATE INDEX IF NOT EXISTS idx_favouritecourts_courtid
  ON public.favouritecourts (courtid);

-- ── notifications ────────────────────────────────────────────────────────────
-- (Already covered by compound indexes in reviews_notifications_migration.sql,
--  but the plain FK index is kept here for completeness / safety.)
CREATE INDEX IF NOT EXISTS idx_notifications_userid
  ON public.notifications (userid);

-- ── playingcourt ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_playingcourt_courtid
  ON public.playingcourt (courtid);

-- ── playingcourtinfo ─────────────────────────────────────────────────────────
-- playingcourtid has a UNIQUE constraint which already creates an index.
-- Added here explicitly so tooling can find it.
CREATE INDEX IF NOT EXISTS idx_playingcourtinfo_playingcourtid
  ON public.playingcourtinfo (playingcourtid);

-- ── review_reactions ─────────────────────────────────────────────────────────
-- Already created in reviews_notifications_migration.sql but guarded.
CREATE INDEX IF NOT EXISTS idx_review_reactions_reviewid
  ON public.review_reactions (reviewid);
CREATE INDEX IF NOT EXISTS idx_review_reactions_userid
  ON public.review_reactions (userid);

-- ── reviews ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_reviews_userid
  ON public.reviews (userid);

-- ── servicebooking ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_servicebooking_courtbookingid
  ON public.servicebooking (courtbookingid);
CREATE INDEX IF NOT EXISTS idx_servicebooking_serviceid
  ON public.servicebooking (serviceid);
CREATE INDEX IF NOT EXISTS idx_servicebooking_paymentid
  ON public.servicebooking (paymentid);

-- ── services ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_services_courtid
  ON public.services (courtid);

-- ── trainingsessioninfo ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trainingsessioninfo_sessionid
  ON public.trainingsessioninfo (sessionid);

-- ── trainingsessions ─────────────────────────────────────────────────────────
-- courtbookingid already has a UNIQUE constraint (which creates an index).
CREATE INDEX IF NOT EXISTS idx_trainingsessions_coachid
  ON public.trainingsessions (coachid);

-- ── tsbookings ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tsbookings_sessionid
  ON public.tsbookings (sessionid);
CREATE INDEX IF NOT EXISTS idx_tsbookings_paymentid
  ON public.tsbookings (paymentid);
CREATE INDEX IF NOT EXISTS idx_tsbookings_userid
  ON public.tsbookings (userid);

-- ── unverified_users ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_unverified_users_userid
  ON public.unverified_users (userid);

-- ── user_tokens ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_tokens_userid
  ON public.user_tokens (userid);

-- ── userinfo ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_userinfo_userid
  ON public.userinfo (userid);

-- ── userlogin ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_userlogin_userid
  ON public.userlogin (userid);


-- ============================================================================
-- SECTION 3 · SPECIAL INDEXES
-- ============================================================================

-- --------------------------------------------------------------------------
-- 3-A  GIN index on booking_date JSONB
--      Allows the map screen to filter courts that are open on a specific
--      day-of-week by querying:  booking_date @> '{"mon": true}'
--      Without this, every JSONB containment check is an O(N) scan.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_courtavailability_booking_date_gin
  ON public.courtavailability USING GIN (booking_date);

-- --------------------------------------------------------------------------
-- 3-B  B-Tree indexes on courtbooking timestamps
--      Accelerates range queries like:
--        WHERE start_timestamp >= now() AND start_timestamp < now() + interval '7 days'
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_courtbooking_start_timestamp
  ON public.courtbooking (start_timestamp);

CREATE INDEX IF NOT EXISTS idx_courtbooking_end_timestamp
  ON public.courtbooking (end_timestamp);

-- Composite: covers the common "overlap" predicate in a single index scan
--   WHERE start_timestamp < :range_end AND end_timestamp > :range_start
CREATE INDEX IF NOT EXISTS idx_courtbooking_timestamps_range
  ON public.courtbooking (start_timestamp, end_timestamp);

-- --------------------------------------------------------------------------
-- 3-C  Partial index — upcoming bookings (the hottest read path)
--      Covers the schedule screen query:
--        SELECT … FROM courtbooking WHERE userid = ? AND bookingstatus = 'upcoming'
--      Much smaller than a full index; fits in shared_buffers more easily.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_courtbooking_upcoming_by_user
  ON public.courtbooking (userid, start_timestamp)
  WHERE bookingstatus = 'upcoming';

-- Mirror for events and training sessions (same pattern, same benefit)
CREATE INDEX IF NOT EXISTS idx_eventbooking_upcoming_by_user
  ON public.eventbooking (userid)
  WHERE bookingstatus = 'upcoming';

CREATE INDEX IF NOT EXISTS idx_tsbookings_upcoming_by_user
  ON public.tsbookings (userid)
  WHERE bookingstatus = 'upcoming';

-- --------------------------------------------------------------------------
-- 3-D  Map screen: composite index on (latitude, longitude)
--      Enables fast bounding-box queries:
--        WHERE latitude BETWEEN :lat_min AND :lat_max
--          AND longitude BETWEEN :lng_min AND :lng_max
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_courtinfo_lat_lng
  ON public.courtinfo (latitude, longitude);

-- --------------------------------------------------------------------------
-- 3-E  Status / enum filter indexes
--      Low-cardinality columns are only worth indexing when the query also
--      filters on a high-cardinality column (e.g. userid), OR when a partial
--      index (above) cannot be used.  These cover the court-owner dashboard
--      and admin views.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_courtbooking_status
  ON public.courtbooking (status);          -- pending | approved | rejected

CREATE INDEX IF NOT EXISTS idx_courtbooking_bookingstatus
  ON public.courtbooking (bookingstatus);   -- upcoming | completed | cancelled

CREATE INDEX IF NOT EXISTS idx_eventbooking_bookingstatus
  ON public.eventbooking (bookingstatus);

CREATE INDEX IF NOT EXISTS idx_tsbookings_bookingstatus
  ON public.tsbookings (bookingstatus);

CREATE INDEX IF NOT EXISTS idx_events_status
  ON public.events (status);

CREATE INDEX IF NOT EXISTS idx_trainingsessions_status
  ON public.trainingsessions (status);

CREATE INDEX IF NOT EXISTS idx_courts_status
  ON public.courts (status);

-- --------------------------------------------------------------------------
-- 3-F  Composite for the "get reviews for a target" query
--        SELECT … FROM reviews WHERE targettype = 'court' AND targetid = ?
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reviews_target
  ON public.reviews (targettype, targetid);


-- ============================================================================
-- SECTION 4 · BOOKING RPC  (rpc_create_court_booking)
-- ============================================================================
-- Atomically:
--   1. Locks the courtavailability row        → prevents double-booking
--   2. Verifies the slot is still available   → clean rejection if raced
--   3. Reads auto_approve from courtinfo      → sets pending vs approved
--   4. Inserts the courtbooking row
--   5. Marks the slot as unavailable
--
-- The entire body executes inside a single implicit transaction (PL/pgSQL
-- default).  If any step raises an exception the whole thing rolls back.
--
-- Call from your backend:
--   SELECT * FROM rpc_create_court_booking(
--     p_availabilityid => 42,  p_userid => 7,
--     p_start_timestamp => '2026-04-01 09:00', ...
--   );
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_court_booking(
  p_availabilityid         int,
  p_userid                 int,
  p_start_timestamp        timestamp,
  p_end_timestamp          timestamp,
  p_bookingdate            date,
  -- optional snapshot columns (all default NULL so callers can omit them)
  p_playingcourtid         bigint              DEFAULT NULL,
  p_selected_court_name    text                DEFAULT NULL,
  p_selected_base_name     text                DEFAULT NULL,
  p_selected_part          text                DEFAULT NULL,  -- 'full'|'half_a'|'half_b'
  p_selected_surface       public.courtsurface DEFAULT NULL,
  p_court_price_at_booking numeric             DEFAULT NULL,
  p_duration_minutes       int                 DEFAULT NULL,
  p_total_amount           numeric             DEFAULT NULL,
  p_note                   text                DEFAULT NULL
)
RETURNS TABLE (
  out_courtbookingid  int,
  out_booking_status  public.courtbookingstatus,
  out_auto_approved   boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_avail_status   public.availabilitystatus;
  v_courtid        int;
  v_auto_approve   boolean;
  v_booking_status public.courtbookingstatus;
  v_new_booking_id int;
BEGIN
  -- ── 1. Lock the availability row ────────────────────────────────────────
  --  FOR UPDATE acquires an exclusive row-level lock.
  --  Any concurrent call for the same slot will block here until this
  --  transaction is committed or rolled back, guaranteeing serialised access.
  SELECT ca.status, ca.courtid
  INTO   v_avail_status, v_courtid
  FROM   courtavailability ca
  WHERE  ca.availabilityid = p_availabilityid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SLOT_NOT_FOUND: availabilityid % does not exist',
      p_availabilityid
      USING ERRCODE = 'P0010';
  END IF;

  -- ── 2. Confirm the slot is still open ───────────────────────────────────
  IF v_avail_status <> 'available' THEN
    RAISE EXCEPTION 'SLOT_TAKEN: availabilityid % is currently "%"',
      p_availabilityid, v_avail_status
      USING ERRCODE = 'P0011';
  END IF;

  -- ── 3. Determine booking approval status ────────────────────────────────
  --  Falls back to 'pending' when courtinfo is missing (NULL-safe).
  SELECT ci.auto_approve
  INTO   v_auto_approve
  FROM   courtinfo ci
  WHERE  ci.courtid = v_courtid
  LIMIT  1;

  v_booking_status := CASE
    WHEN COALESCE(v_auto_approve, false) THEN 'approved'::courtbookingstatus
    ELSE                                       'pending'::courtbookingstatus
  END;

  -- ── 4. Insert the booking ────────────────────────────────────────────────
  INSERT INTO courtbooking (
    availabilityid,
    userid,
    status,
    bookingstatus,
    start_timestamp,
    end_timestamp,
    bookingdate,
    playingcourtid,
    selected_court_name,
    selected_base_name,
    selected_part,
    selected_surface,
    court_price_at_booking,
    duration_minutes,
    total_amount,
    note
  )
  VALUES (
    p_availabilityid,
    p_userid,
    v_booking_status,
    'upcoming'::sessionstatus,
    p_start_timestamp,
    p_end_timestamp,
    p_bookingdate,
    p_playingcourtid,
    p_selected_court_name,
    p_selected_base_name,
    p_selected_part,
    p_selected_surface,
    p_court_price_at_booking,
    p_duration_minutes,
    p_total_amount,
    p_note
  )
  RETURNING courtbooking.courtbookingid INTO v_new_booking_id;

  -- ── 5. Close the slot ───────────────────────────────────────────────────
  --  This row is already exclusively locked from step 1; the UPDATE is
  --  instant and does not require a separate lock acquisition.
  UPDATE courtavailability
  SET    status = 'unavailable'
  WHERE  availabilityid = p_availabilityid;

  -- ── 6. Return result to the caller ──────────────────────────────────────
  RETURN QUERY
    SELECT v_new_booking_id,
           v_booking_status,
           COALESCE(v_auto_approve, false);
END;
$$;

-- Grant to authenticated callers via your custom auth middleware
-- (replace 'authenticator' with the role your backend uses if different)
-- GRANT EXECUTE ON FUNCTION public.rpc_create_court_booking TO authenticator;


-- ============================================================================
-- SECTION 5 · EVENT & TRAINING SESSION JOIN RPCs
-- ============================================================================
-- Both functions use the same FOR UPDATE serialisation pattern as the court
-- booking RPC.  They enforce participants_cap, prevent duplicate bookings,
-- use the target table as the lock anchor, and return the new booking ID +
-- the resolved status (pending vs joined).
-- ============================================================================

-- --------------------------------------------------------------------------
-- 5-A  rpc_join_event
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_join_event(
  p_eventid   int,
  p_userid    int,
  p_paymentid int  DEFAULT NULL,
  p_note      text DEFAULT NULL
)
RETURNS TABLE (out_eventbookingid int, out_booking_status public.eventbookingstatus)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_status  public.eventstatus;
  v_join_status   boolean;
  v_auto_approve  boolean;
  v_cap           int;
  v_count         int;
  v_new_status    public.eventbookingstatus;
  v_new_id        int;
BEGIN
  -- ── 1. Lock the events row ───────────────────────────────────────────────
  --  Any concurrent join call for the same event will wait here, guaranteeing
  --  that the capacity check in step 3 is never racy.
  SELECT e.status
  INTO   v_event_status
  FROM   events e
  WHERE  e.eventid = p_eventid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND: eventid % does not exist', p_eventid
      USING ERRCODE = 'P0020';
  END IF;

  IF v_event_status <> 'upcoming'::eventstatus THEN
    RAISE EXCEPTION 'EVENT_NOT_JOINABLE: event % has status "%"', p_eventid, v_event_status
      USING ERRCODE = 'P0021';
  END IF;

  -- ── 2. Read capacity / approval rules ────────────────────────────────────
  SELECT COALESCE(ei.participants_cap, 0),
         COALESCE(ei.join_status,      true),
         COALESCE(ei.auto_approve,     false)
  INTO   v_cap, v_join_status, v_auto_approve
  FROM   eventinfo ei
  WHERE  ei.eventid = p_eventid
  LIMIT  1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_INFO_MISSING: no eventinfo row for eventid %', p_eventid
      USING ERRCODE = 'P0025';
  END IF;

  IF NOT v_join_status THEN
    RAISE EXCEPTION 'EVENT_CLOSED: event % is not accepting new participants', p_eventid
      USING ERRCODE = 'P0022';
  END IF;

  -- ── 3. Count active participants (pending + joined, not cancelled) ────────
  SELECT COUNT(*)
  INTO   v_count
  FROM   eventbooking eb
  WHERE  eb.eventid = p_eventid
    AND  eb.status  IN ('pending'::eventbookingstatus, 'joined'::eventbookingstatus);

  IF v_count >= v_cap THEN
    RAISE EXCEPTION 'EVENT_FULL: event % has reached capacity (%/%)', p_eventid, v_count, v_cap
      USING ERRCODE = 'P0023';
  END IF;

  -- ── 4. Prevent duplicate active booking ──────────────────────────────────
  IF EXISTS (
    SELECT 1
    FROM   eventbooking eb
    WHERE  eb.eventid       = p_eventid
      AND  eb.userid        = p_userid
      AND  eb.bookingstatus <> 'cancelled'::sessionstatus
  ) THEN
    RAISE EXCEPTION 'ALREADY_JOINED: user % already has an active booking for event %',
      p_userid, p_eventid
      USING ERRCODE = 'P0024';
  END IF;

  -- ── 5. Determine booking approval status ─────────────────────────────────
  v_new_status := CASE
    WHEN v_auto_approve THEN 'joined'::eventbookingstatus
    ELSE                     'pending'::eventbookingstatus
  END;

  -- ── 6. Insert event booking ───────────────────────────────────────────────
  INSERT INTO eventbooking (eventid, userid, paymentid, status, bookingstatus, note)
  VALUES (p_eventid, p_userid, p_paymentid, v_new_status, 'upcoming'::sessionstatus, p_note)
  RETURNING eventbooking.eventbookingid INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_new_status;
END;
$$;

-- GRANT EXECUTE ON FUNCTION public.rpc_join_event TO authenticator;


-- --------------------------------------------------------------------------
-- 5-B  rpc_join_training_session
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_join_training_session(
  p_sessionid int,
  p_userid    int,
  p_paymentid int  DEFAULT NULL,
  p_note      text DEFAULT NULL
)
RETURNS TABLE (out_tsbookingid int, out_booking_status public.tsbookingstatus)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_status  public.sessionstatus;
  v_join_status     boolean;
  v_cap             int;
  v_count           int;
  v_new_id          int;
BEGIN
  -- ── 1. Lock the trainingsessions row ─────────────────────────────────────
  SELECT ts.status
  INTO   v_session_status
  FROM   trainingsessions ts
  WHERE  ts.sessionid = p_sessionid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: sessionid % does not exist', p_sessionid
      USING ERRCODE = 'P0030';
  END IF;

  IF v_session_status <> 'upcoming'::sessionstatus THEN
    RAISE EXCEPTION 'SESSION_NOT_JOINABLE: session % has status "%"', p_sessionid, v_session_status
      USING ERRCODE = 'P0031';
  END IF;

  -- ── 2. Read capacity / join rules ─────────────────────────────────────────
  SELECT COALESCE(tsi.participants_cap, 0),
         COALESCE(tsi.join_status,      true)
  INTO   v_cap, v_join_status
  FROM   trainingsessioninfo tsi
  WHERE  tsi.sessionid = p_sessionid
  LIMIT  1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_INFO_MISSING: no trainingsessioninfo row for sessionid %', p_sessionid
      USING ERRCODE = 'P0035';
  END IF;

  IF NOT v_join_status THEN
    RAISE EXCEPTION 'SESSION_CLOSED: training session % is not accepting new participants', p_sessionid
      USING ERRCODE = 'P0032';
  END IF;

  -- ── 3. Count active participants (pending + joined) ───────────────────────
  SELECT COUNT(*)
  INTO   v_count
  FROM   tsbookings tb
  WHERE  tb.sessionid = p_sessionid
    AND  tb.status    IN ('pending'::tsbookingstatus, 'joined'::tsbookingstatus);

  IF v_count >= v_cap THEN
    RAISE EXCEPTION 'SESSION_FULL: session % has reached capacity (%/%)', p_sessionid, v_count, v_cap
      USING ERRCODE = 'P0033';
  END IF;

  -- ── 4. Prevent duplicate active booking ──────────────────────────────────
  IF EXISTS (
    SELECT 1
    FROM   tsbookings tb
    WHERE  tb.sessionid    = p_sessionid
      AND  tb.userid       = p_userid
      AND  tb.bookingstatus <> 'cancelled'::sessionstatus
  ) THEN
    RAISE EXCEPTION 'ALREADY_JOINED: user % already has an active booking for session %',
      p_userid, p_sessionid
      USING ERRCODE = 'P0034';
  END IF;

  -- ── 5. Insert training booking (always pending — trainingsessioninfo has no auto_approve) ──
  INSERT INTO tsbookings (sessionid, userid, paymentid, status, bookingstatus, note)
  VALUES (p_sessionid, p_userid, p_paymentid, 'pending'::tsbookingstatus, 'upcoming'::sessionstatus, p_note)
  RETURNING tsbookings.tsbookingid INTO v_new_id;

  RETURN QUERY SELECT v_new_id, 'pending'::tsbookingstatus;
END;
$$;

-- GRANT EXECUTE ON FUNCTION public.rpc_join_training_session TO authenticator;


-- --------------------------------------------------------------------------
-- 5-C  Fix: add DEFAULT NULL to rpc_upsert_review_reaction so that callers
--      can omit p_reaction to trigger the remove-reaction path.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_upsert_review_reaction(
  p_userid   int,
  p_reviewid int,
  p_reaction public.review_reaction_type DEFAULT NULL  -- NULL → remove reaction
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_targettype   public.reviewtargettype;
  v_targetid     int;
  v_old_reaction public.review_reaction_type;
BEGIN
  SELECT r.targettype, r.targetid
  INTO   v_targettype, v_targetid
  FROM   public.reviews r
  WHERE  r.reviewid = p_reviewid
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_NOT_FOUND: reviewid %', p_reviewid
      USING ERRCODE = 'P0003';
  END IF;

  IF NOT public.has_completed_booking(p_userid, v_targettype, v_targetid) THEN
    RAISE EXCEPTION
      'REACTION_NOT_ELIGIBLE: user % has no completed booking for % id=%',
      p_userid, v_targettype, v_targetid
      USING ERRCODE = 'P0001';
  END IF;

  SELECT rr.reaction
  INTO   v_old_reaction
  FROM   public.review_reactions rr
  WHERE  rr.reviewid = p_reviewid
    AND  rr.userid   = p_userid;

  IF p_reaction IS NULL THEN
    DELETE FROM public.review_reactions
    WHERE  reviewid = p_reviewid AND userid = p_userid;

    IF v_old_reaction = 'like' THEN
      UPDATE public.reviews SET like_count    = GREATEST(0, like_count    - 1) WHERE public.reviews.reviewid = p_reviewid;
    ELSIF v_old_reaction = 'dislike' THEN
      UPDATE public.reviews SET dislike_count = GREATEST(0, dislike_count - 1) WHERE public.reviews.reviewid = p_reviewid;
    END IF;

  ELSE
    INSERT INTO public.review_reactions (reviewid, userid, reaction)
    VALUES (p_reviewid, p_userid, p_reaction)
    ON CONFLICT (reviewid, userid)
    DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now();

    IF v_old_reaction IS DISTINCT FROM p_reaction THEN
      IF v_old_reaction = 'like' THEN
        UPDATE public.reviews SET like_count    = GREATEST(0, like_count    - 1) WHERE public.reviews.reviewid = p_reviewid;
      ELSIF v_old_reaction = 'dislike' THEN
        UPDATE public.reviews SET dislike_count = GREATEST(0, dislike_count - 1) WHERE public.reviews.reviewid = p_reviewid;
      END IF;
      IF p_reaction = 'like' THEN
        UPDATE public.reviews SET like_count    = like_count    + 1 WHERE public.reviews.reviewid = p_reviewid;
      ELSIF p_reaction = 'dislike' THEN
        UPDATE public.reviews SET dislike_count = dislike_count + 1 WHERE public.reviews.reviewid = p_reviewid;
      END IF;
    END IF;
  END IF;
END;
$$;


COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
-- Quick sanity check (run separately after migration):
--
-- SELECT indexname, indexdef
-- FROM   pg_indexes
-- WHERE  schemaname = 'public'
-- ORDER  BY tablename, indexname;
--
-- SELECT proname, prosrc
-- FROM   pg_proc p
-- JOIN   pg_namespace n ON n.oid = p.pronamespace
-- WHERE  n.nspname = 'public'
--   AND  proname IN (
--     'has_completed_booking',
--     'rpc_create_review',
--     'rpc_upsert_review_reaction',
--     'rpc_create_court_booking'
--   );
-- =============================================================================
