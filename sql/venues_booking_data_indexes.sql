-- Optimize /api/venues/{courtid}/booking-data cold-start reads
-- Run this in Supabase SQL Editor.

-- 1) playingcourt filtered by courtid
create index if not exists idx_playingcourt_courtid
  on public.playingcourt using btree (courtid);

-- 2) courtavailability filtered by courtid
create index if not exists idx_courtavailability_courtid
  on public.courtavailability using btree (courtid);

-- 3) courtavailability joins/filter via playingcourtid
create index if not exists idx_courtavailability_playingcourtid
  on public.courtavailability using btree (playingcourtid);

-- 4) playingcourtinfo lookup by playingcourtid (often used in booking bundle)
create index if not exists idx_playingcourtinfo_playingcourtid
  on public.playingcourtinfo using btree (playingcourtid);
