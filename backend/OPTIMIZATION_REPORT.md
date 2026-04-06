# SportConnect — Backend & SQL Optimization Report

## Priority 1: N+1 Query Elimination

### `_enrich_court_bookings` (courtbookings.py)
**Current**: 7 sequential REST calls per request (availability, playingcourt, courts, courtinfo, userinfo ×2, events, trainingsessions).
**Impact**: 50 bookings = ~350 HTTP round-trips.
**Fix**: Use PostgREST nested select in a single call:
```python
rest_select(
    "courtbooking",
    "*, courtavailability(*, playingcourt(*, courts(*, courtinfo(*)))), "
    "events(*, eventinfo(*)), trainingsessions(*, trainingsessioninfo(*))",
    filters={"userid": f"eq.{userid}"}
)
```

### `_list_court_bookings_sync` (courtbookings.py)
**Current**: 3 chained queries (court → playingcourt → availability → bookings).
**Fix**: Single relational query filtering by courtid through the chain.

### `history.py`
**Current**: Fetches **entire** `trainingsessions` table then filters in Python.
**Fix**: Push userid filter to SQL level:
```python
rest_select("trainingsessions", "*", filters={"coachid": f"eq.{userid}"})
```

---

## Priority 2: Missing SQL Indexes

### Reviews by court (most common query pattern)
```sql
CREATE INDEX idx_reviews_court_target
ON reviews (targetid, created_at DESC)
WHERE targettype = 'court';
```

### Review reactions batch lookup
```sql
CREATE INDEX idx_review_reactions_reviewid
ON review_reactions (reviewid, reaction);
```

### Court schedule rules by court+day
```sql
CREATE INDEX idx_schedule_rules_court_day
ON court_schedule_rules (courtid, day_of_week, valid_from, valid_to);
```

### Payments — add user tracking
The `payments` table has **no userid column**. Querying "all payments by user" requires UNION across 3 booking tables.
```sql
ALTER TABLE payments ADD COLUMN userid INTEGER REFERENCES users(userid);
CREATE INDEX idx_payments_userid ON payments (userid, time DESC);
-- Backfill from existing booking data
```

---

## Priority 3: Row-Level Security (RLS)

Only `userlogin` has RLS. Add policies to sensitive tables:

```sql
-- user_tokens: users see only their own tokens
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_tokens" ON user_tokens
  FOR ALL USING (userid = auth.uid()::int);

-- user_devices: users see only their own devices
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_devices" ON user_devices
  FOR ALL USING (userid = auth.uid()::int);

-- notifications: users see only their own
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_notifications" ON notifications
  FOR ALL USING (userid = auth.uid()::int);

-- courtbooking: users see only their own bookings
ALTER TABLE courtbooking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_bookings" ON courtbooking
  FOR SELECT USING (userid = auth.uid()::int);

-- Service role bypass for backend API
CREATE POLICY "service_full_access" ON user_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- (repeat for each table)
```

**Note**: Since your backend uses `service_role` key, backend API calls bypass RLS. These policies protect against direct Supabase client access.

---

## Priority 4: JSONB Schema Validation

`courtavailability.booking_date` is unstructured JSONB. Add a CHECK constraint:
```sql
ALTER TABLE courtavailability
ADD CONSTRAINT chk_booking_date_structure
CHECK (
  booking_date IS NULL
  OR (
    jsonb_typeof(booking_date) = 'object'
    AND booking_date ? 'date'
  )
);
```

---

## Priority 5: Cascade Cleanup (courts.py)

**Current**: Loop with individual DELETE calls per playingcourt.
**Fix**: SQL CASCADE already handles this — the loop is unnecessary. Deleting from `courts` cascades to `courtinfo`, `playingcourt`, `playingcourtinfo`, `court_schedule_rules`, `services`.

Just delete the parent:
```python
rest_delete("courts", {"courtid": f"eq.{courtid}"})
# All children auto-cascade
```

---

## Priority 6: Materialized View for Dashboard

The dashboard joins across 6+ tables. Create a materialized view:
```sql
CREATE MATERIALIZED VIEW mv_user_dashboard AS
SELECT
  u.userid,
  json_agg(DISTINCT jsonb_build_object(
    'bookingid', cb.courtbookingid,
    'status', cb.bookingstatus,
    'start', cb.start_timestamp,
    'court_name', ci.name,
    'address', ci.address
  )) FILTER (WHERE cb.courtbookingid IS NOT NULL) AS court_bookings,
  (SELECT count(*) FROM notifications n WHERE n.userid = u.userid AND n.status = 'unread') AS unread_count
FROM users u
LEFT JOIN courtbooking cb ON cb.userid = u.userid AND cb.bookingstatus = 'upcoming'
LEFT JOIN courtavailability ca ON ca.availabilityid = cb.availabilityid
LEFT JOIN courtinfo ci ON ci.courtid = ca.courtid
GROUP BY u.userid;

CREATE UNIQUE INDEX ON mv_user_dashboard (userid);
-- Refresh periodically: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_dashboard;
```

---

## Summary Table

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| P1 | N+1 in `_enrich_court_bookings` | 80%+ load reduction | Medium |
| P1 | Full table scan in `history.py` | Grows with data | Low |
| P2 | Missing review indexes | Slow review pages | Low |
| P2 | Payments missing userid | Slow payment queries | Medium |
| P3 | Missing RLS on 28 tables | Security risk | Medium |
| P4 | JSONB schema validation | Data integrity | Low |
| P5 | Redundant cascade deletes | Code cleanup | Low |
| P6 | Dashboard materialized view | Dashboard speed | High |
