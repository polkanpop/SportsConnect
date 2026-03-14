-- Reviews + Notifications redesign (migration script)
--
-- Apply in Supabase SQL editor.
-- This script is designed to be re-runnable (uses IF NOT EXISTS where possible).

begin;

-- -----------------------------
-- Notifications upgrades
-- -----------------------------

do $$
begin
  -- Category is used by the unified Notifications UI filter.
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'notification_category'
  ) then
    create type public.notification_category as enum ('court', 'event', 'training');
  end if;
exception when duplicate_object then
  null;
end $$;

alter table if exists public.notifications
  add column if not exists category public.notification_category,
  add column if not exists kind text,
  add column if not exists data jsonb not null default '{}'::jsonb,
  add column if not exists read_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

-- Best-effort backfill
update public.notifications
set created_at = coalesce(created_at, "time", now())
where created_at is null;

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public' and table_name = 'notifications'
  ) then
    if not exists (
      select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'notifications'
        and c.conname = 'notifications_status_chk'
    ) then
      execute 'alter table public.notifications add constraint notifications_status_chk check (status in (''unread'',''read''))';
    end if;
  end if;
end $$;

create index if not exists notifications_user_time_idx
  on public.notifications (userid, "time" desc);

create index if not exists notifications_user_status_time_idx
  on public.notifications (userid, status, "time" desc);

create index if not exists notifications_user_category_time_idx
  on public.notifications (userid, category, "time" desc);

-- -----------------------------
-- Reviews upgrades
-- -----------------------------

alter table if exists public.reviews
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz;

create or replace function public._set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Trigger is safe even if duplicated: drop then create.
drop trigger if exists trg_reviews_updated_at on public.reviews;
create trigger trg_reviews_updated_at
before update on public.reviews
for each row
execute function public._set_updated_at();

-- -----------------------------
-- Review reactions
-- -----------------------------

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'review_reaction_type'
  ) then
    create type public.review_reaction_type as enum ('like', 'dislike');
  end if;
exception when duplicate_object then
  null;
end $$;

create table if not exists public.review_reactions (
  reactionid bigserial primary key,
  reviewid int not null references public.reviews(reviewid) on delete cascade,
  userid int not null references public.users(userid) on delete cascade,
  reaction public.review_reaction_type not null,
  created_at timestamptz not null default now(),
  unique (reviewid, userid)
);

create index if not exists review_reactions_review_idx on public.review_reactions (reviewid);
create index if not exists review_reactions_user_idx on public.review_reactions (userid);

-- -----------------------------
-- Eligibility enforcement helpers
-- -----------------------------

-- NOTE: Intentionally no admin/owner/host logic yet.
-- We'll add role-based exclusions later once the app has that concept wired end-to-end.

create or replace function public._has_completed_court_trip(p_userid int, p_courtid int)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.courtbooking cb
    join public.courtavailability ca on ca.availabilityid = cb.availabilityid
    where cb.userid = p_userid
      and ca.courtid = p_courtid
      and lower(coalesce(cb.bookingstatus::text, '')) = 'completed'
      and lower(coalesce(cb.status::text, '')) not like '%cancel%'
  )
$$;

-- Enforce: only users who completed the court trip can create a review.
create or replace function public._enforce_review_eligibility()
returns trigger
language plpgsql
as $$
begin
  if lower(coalesce(new.targettype, '')) <> 'court' then
    raise exception 'Only court reviews are supported right now (targettype=court)';
  end if;

  if new.userid is null then
    raise exception 'userid is required';
  end if;

  if new.targetid is null then
    raise exception 'targetid is required';
  end if;

  if new.rating is null or new.rating < 1 or new.rating > 5 then
    raise exception 'rating must be between 1 and 5';
  end if;

  if not public._has_completed_court_trip(new.userid, new.targetid) then
    raise exception 'Only users with a completed trip can review this court';
  end if;

  return new;
end $$;

drop trigger if exists trg_reviews_eligibility on public.reviews;
create trigger trg_reviews_eligibility
before insert on public.reviews
for each row
execute function public._enforce_review_eligibility();

-- Enforce: only "been there" users can like/dislike.
create or replace function public._enforce_review_reaction_eligibility()
returns trigger
language plpgsql
as $$
declare
  v_targettype text;
  v_targetid int;
begin
  select r.targettype, r.targetid
  into v_targettype, v_targetid
  from public.reviews r
  where r.reviewid = new.reviewid;

  if v_targettype is null then
    raise exception 'review not found';
  end if;

  if lower(coalesce(v_targettype, '')) <> 'court' then
    raise exception 'Only court review reactions are supported right now';
  end if;

  if not public._has_completed_court_trip(new.userid, v_targetid) then
    raise exception 'Only users with a completed trip can react to reviews for this court';
  end if;

  return new;
end $$;

drop trigger if exists trg_review_reactions_eligibility on public.review_reactions;
create trigger trg_review_reactions_eligibility
before insert on public.review_reactions
for each row
execute function public._enforce_review_reaction_eligibility();

commit;
