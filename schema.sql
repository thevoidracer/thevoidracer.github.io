-- v0 schema: just enough to prove the pipeline end to end.
-- "team" is a parameter everywhere, not a hardcoded value anywhere in this schema.

create table if not exists teams (
  tag              text primary key,
  display_name     text,
  created_at       timestamptz not null default now(), -- when WE started tracking it
  last_synced_at   timestamptz,
  next_sync_due_at timestamptz,
  -- Team-profile fields from Nitro Type's own API (info block), used to
  -- render a roster page structured like the stats-dashboard genre this
  -- project is part of: a hero banner + requirements bar above the table.
  captain_username      text,
  captain_display_name  text,
  members_count         integer,
  nt_created_at          timestamptz, -- the team's own formation date on Nitro Type
  min_races              integer,
  min_speed              integer,
  min_level              integer,
  enrollment             text,
  other_requirements     text,
  -- The team's own color from Nitro Type's API (a hex string with no "#"),
  -- e.g. "5b52a3". Used verbatim as the team's accent everywhere on this
  -- site so there's never any mismatch with the real NT team page -
  -- deliberately not a color we compute ourselves.
  tag_color              text
);

create table if not exists racers (
  nt_user_id   bigint primary key,
  username     text not null,
  team_tag     text references teams(tag) on delete set null,
  updated_at   timestamptz not null default now(),
  -- Current-status fields (not time-series, so they live on the racer row
  -- itself rather than in racer_stats): role/membership/join date change
  -- rarely and we only need the latest value, same as team_tag.
  role         text,
  membership   text,
  joined_at_nt timestamptz,
  -- Nitro Type's API gives each member BOTH a "username" (often an opaque
  -- id-looking string NT assigns internally, e.g. "b9454b42ad92beb74...")
  -- AND a separate "displayName" - the actual name the racer currently
  -- goes by on the site. We show display_name everywhere a human reads a
  -- racer's name, falling back to username only for the rare racer this
  -- tracker hasn't re-synced since this column was added.
  display_name text,
  -- The car the racer currently has equipped, straight from Nitro Type's
  -- team API (member.carID/member.carHueAngle - also what verify-car-swap
  -- already reads live to run the car-swap proof). car_hue_angle is 0/null
  -- for a car's stock color and non-zero for a repaint. Rendered as a small
  -- thumbnail next to the racer's name (see car-catalog.js/theme.js's
  -- carImageUrl) - best-effort only, since we only have a slug->image
  -- mapping for the cars we've been able to confirm, so this is nullable
  -- and a racer with an unmapped or brand-new car just shows no picture.
  car_id         integer,
  car_hue_angle  integer
);

-- One row per sync per racer: snapshots, not overwrites, so history/charts
-- are available from day one instead of needing a later migration.
create table if not exists racer_stats (
  id          bigserial primary key,
  nt_user_id  bigint not null references racers(nt_user_id) on delete cascade,
  captured_at timestamptz not null default now(),
  avg_speed   numeric,
  top_speed   numeric,
  races       integer,
  accuracy    numeric
);

create index if not exists racer_stats_user_time
  on racer_stats (nt_user_id, captured_at desc);

create index if not exists racers_team
  on racers (team_tag);

-- The leaderboard's real scoring ledger: one row per sync per racer, but
-- ONLY when that sync found new races completed since the previous one
-- (races_delta > 0). Each row's points = (avg_speed/2 + accuracy) at that
-- sync, times races_delta - an approximation of "points per race this
-- interval" using the racer's current cumulative speed/accuracy as the
-- per-race rate, since Nitro Type's API doesn't expose individual races.
-- A racer's first-ever sync writes no row (there's no previous races
-- count to diff against), so points start accumulating from whenever a
-- racer was first added to this tracker - never backfilled from NT's own
-- history, same as racer_stats. team_tag is captured at insert time (not
-- looked up from racers.team_tag) so a later team switch doesn't rewrite
-- history. Summing this table (optionally windowed by captured_at) is
-- what the Hourly/Daily/Weekly/Monthly/All-Time leaderboards are.
create table if not exists racer_points (
  id          bigserial primary key,
  nt_user_id  bigint not null references racers(nt_user_id) on delete cascade,
  team_tag    text references teams(tag) on delete set null,
  captured_at timestamptz not null default now(),
  races_delta integer not null,
  points      numeric not null,
  -- The avg_speed/accuracy this points award was computed from (see
  -- ingest.js's recordRacerPoints). Stored alongside points, not just
  -- baked into it, so a team leaderboard can show an honest races-weighted
  -- average WPM/accuracy for a window instead of just a points total.
  -- Nullable: rows written before this column existed have no value here
  -- (never backfilled) and are simply excluded from that weighted average.
  avg_speed   numeric,
  accuracy    numeric
);

create index if not exists racer_points_user_time
  on racer_points (nt_user_id, captured_at desc);

create index if not exists racer_points_team_time
  on racer_points (team_tag, captured_at desc);

-- Explicit ALTERs (not just CREATE TABLE IF NOT EXISTS) so re-running this
-- file against a database that already has teams/racers from before these
-- columns existed still brings it up to date, instead of silently no-op'ing.
alter table teams add column if not exists captain_username text;
alter table teams add column if not exists captain_display_name text;
alter table teams add column if not exists members_count integer;
alter table teams add column if not exists nt_created_at timestamptz;
alter table teams add column if not exists min_races integer;
alter table teams add column if not exists min_speed integer;
alter table teams add column if not exists min_level integer;
alter table teams add column if not exists enrollment text;
alter table teams add column if not exists other_requirements text;
alter table teams add column if not exists tag_color text;

alter table racers add column if not exists role text;
alter table racers add column if not exists membership text;
alter table racers add column if not exists joined_at_nt timestamptz;
alter table racers add column if not exists display_name text;

alter table racer_points add column if not exists avg_speed numeric;
alter table racer_points add column if not exists accuracy numeric;

-- How often THIS team gets re-synced, independent of every other team - a
-- quiet team that rarely races can be set to 60+ minutes instead of the
-- default 30, so it isn't pulled as often as an active one. Changed with
-- src/set-sync-interval.js, which is never exposed on the live site or any
-- workflow a visitor can trigger - the only way to change it is to ask
-- (same model as data/events.json), which is what keeps this "admin-only"
-- for now without needing to build real authentication.
alter table teams add column if not exists sync_interval_minutes integer not null default 30;

-- Nitro Type's own real season boundary (e.g. "Spirit Racers", Oct 18 -
-- Nov 29) - the exact dates shown in the banner at the top of every NT
-- page. Scraped from NT's public, unauthenticated bootstrap.js asset (see
-- src/season.js), NOT invented by us. One row per season NT has run since
-- we started tracking; the Seasonal leaderboard always uses whichever row
-- has the latest start_stamp.
create table if not exists seasons (
  season_id   bigint primary key,
  name        text not null,
  start_stamp timestamptz not null,
  end_stamp   timestamptz not null,
  synced_at   timestamptz not null default now()
);

-- Auto-detected team events: new members, and lifetime/team race
-- milestones, written by src/ingest.js (see src/notifications.js) by
-- diffing each sync's fresh numbers against the racer's previous sync -
-- never user-entered, never backfilled from before a racer/team was first
-- tracked. `dedup_key` + the unique constraint below is what makes an
-- event fire exactly once (e.g. "this racer crossed 5,000 races for this
-- team") even though ingest re-runs every sync.
create table if not exists notifications (
  id          bigserial primary key,
  team_tag    text not null references teams(tag) on delete cascade,
  kind        text not null, -- 'new_member' | 'lifetime_milestone' | 'team_milestone'
  nt_user_id  bigint references racers(nt_user_id) on delete set null,
  dedup_key   text not null,
  headline    text not null,
  created_at  timestamptz not null default now(),
  unique (team_tag, dedup_key)
);

create index if not exists notifications_team_time
  on notifications (team_tag, created_at desc);

-- Racer accounts: lets a visitor connect their TypeTrack login (Supabase
-- Auth - email/password, never their real Nitro Type password) to a real
-- Nitro Type identity they've PROVEN they own, so the site can tell real
-- captains apart from anyone claiming to be one. Everything below this
-- point is written/read by the browser directly via Supabase's client
-- libraries (using the public anon key) rather than through our own
-- service-role scripts, so Row Level Security is what keeps a signed-in
-- racer from touching another team's events - see the policies at the
-- bottom of this file.

-- NT's own authoritative captain, by userID (not the display-name text
-- already on this row) - this is what a captain's permission check is
-- actually anchored to. Populated straight from the team API's
-- info.userID (src/ingest.js's upsertTeam), never guessed from a name.
alter table teams add column if not exists captain_nt_user_id bigint;

-- One-to-one link between a Supabase Auth user and the Nitro Type racer
-- they've verified ownership of (see verification_challenges below). A
-- racer can only ever be linked to one TypeTrack account and vice versa.
create table if not exists account_links (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  nt_user_id   bigint not null unique references racers(nt_user_id) on delete cascade,
  verified_at  timestamptz not null default now()
);

-- An in-progress "change your car to prove you own this account" check.
-- One row per signed-in user (starting a new check replaces any old one).
-- baseline_car_id is read live from Nitro Type at the moment the check
-- starts; the Edge Function that confirms it re-reads live too, so this
-- never trusts our own batch-synced (and possibly stale) racer_stats.
create table if not exists verification_challenges (
  auth_user_id    uuid primary key references auth.users(id) on delete cascade,
  nt_user_id      bigint not null,
  nt_username     text not null,
  baseline_car_id integer not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

-- Relay table for "live" Nitro Type lookups triggered from outside a
-- GitHub Actions runner (right now: the verify-car-swap Edge Function).
--
-- Why this exists: Nitro Type's API returns HTTP 403 for requests coming
-- from Supabase's Edge Function network (confirmed directly - same URL,
-- same honest User-Agent that src/ingest.js already uses successfully on
-- its GitHub Actions schedule, blocked only from Supabase's IPs). This
-- isn't a User-Agent problem, so the fix isn't to disguise the request -
-- it's to make the live fetch happen from a network that Nitro Type
-- already accepts. The Edge Function dispatches
-- .github/workflows/live-fetch.yml (src/live-fetch.js) with a fresh
-- request_id, that runner calls the exact same fetchTeam() ingest.js
-- already uses and writes the result here, and the Edge Function polls
-- this row until it shows up (or times out).
--
-- Nothing a client ever reads or writes directly - RLS is on with no
-- policies at all, so every anon/authenticated access is denied. The
-- GitHub Actions runner writes via DATABASE_URL (the direct Postgres
-- connection already used by ingest.js, which bypasses RLS entirely, same
-- as every other scheduled sync job); the Edge Function reads/cleans up
-- via the service-role key (also bypasses RLS). Rows are short-lived -
-- the Edge Function deletes the one it's waiting on once it's read, and
-- opportunistically sweeps anything older than an hour (a result that
-- arrives after the Edge Function gave up and nobody ever claims).
create table if not exists live_fetch_requests (
  request_id   uuid primary key,
  team_tag     text not null,
  members      jsonb,
  error        text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists live_fetch_requests_requested_at
  on live_fetch_requests (requested_at);

alter table live_fetch_requests enable row level security;
-- Deliberately zero policies - see comment above the table.

-- Team events - same purpose as the old data/events.json, but writable by
-- a verified team captain directly from their team's Events page instead
-- of being a file only changed by hand. Deliberately one team per event
-- (not the old file's array-of-teams), since the RLS policy below checks
-- a captain against exactly one team_tag; an event spanning several
-- allied teams would need one row per team.
create table if not exists events (
  id          bigserial primary key,
  team_tag    text not null references teams(tag) on delete cascade,
  title       text not null,
  description text,
  start_stamp timestamptz not null,
  end_stamp   timestamptz not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists events_team_time on events (team_tag, start_stamp desc);

alter table account_links enable row level security;
alter table verification_challenges enable row level security;
alter table events enable row level security;

-- account_links: a racer's verified-or-not status is harmless to show
-- publicly (just "this racer owns this TypeTrack account"), so reads are
-- open. Deliberately NO insert/update/delete policy for any client role:
-- letting a signed-in user write their own auth_user_id here would still
-- let them pair it with ANY nt_user_id and falsely claim to be a racer
-- they never actually verified - the whole point of the car-swap check.
-- The only thing allowed to write this table is the verify-car-swap Edge
-- Function, using Supabase's service-role key (which bypasses RLS
-- entirely, by design - it's the trusted server-side half of this flow).
-- With RLS on and no write policy, every client-side write is denied.
drop policy if exists "account_links are publicly readable" on account_links;
create policy "account_links are publicly readable" on account_links
  for select using (true);

-- verification_challenges: not even publicly readable, and - like
-- account_links above - never written by the client directly. The
-- verify-car-swap Edge Function owns this table completely (via the
-- service-role key): it creates the challenge when a check starts and
-- deletes it once confirmed, and returns the challenge's state straight
-- in its own response rather than making the browser query this table.
-- With RLS on and no policies at all, this table is fully inaccessible
-- to the client - exactly what we want for in-progress verification state.

-- events: anyone can read (it's a public site); writes are restricted to
-- a signed-in user who is BOTH verified as a specific racer (via
-- account_links) AND that racer is the captain NT itself recognizes for
-- the team_tag being written - so a captain can only ever manage events
-- for their own team, never someone else's.
drop policy if exists "events are publicly readable" on events;
create policy "events are publicly readable" on events
  for select using (true);

drop policy if exists "only a team's own verified captain manages its events" on events;
create policy "only a team's own verified captain manages its events" on events
  for all
  using (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = events.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = events.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  );

-- Officers: a captain-appointed tier between "captain" and "everyone else".
-- One row per (team, racer) means a racer is an officer of THAT team -
-- deliberately keyed by team_tag + nt_user_id (not just nt_user_id alone)
-- so moving teams doesn't carry officer status along, same spirit as
-- racer_points.team_tag being captured rather than re-derived. Captain
-- status itself still comes from teams.captain_nt_user_id, never from a
-- row here - a captain is never also stored as their own team's officer.
create table if not exists team_officers (
  team_tag     text not null references teams(tag) on delete cascade,
  nt_user_id   bigint not null references racers(nt_user_id) on delete cascade,
  appointed_by uuid references auth.users(id) on delete set null,
  appointed_at timestamptz not null default now(),
  primary key (team_tag, nt_user_id)
);

alter table team_officers enable row level security;

-- Readable by anyone (officer badges show up on the public roster/team
-- admin page); only that team's own verified captain can appoint or
-- remove an officer - the exact same ownership check events uses above.
drop policy if exists "team_officers are publicly readable" on team_officers;
create policy "team_officers are publicly readable" on team_officers
  for select using (true);

drop policy if exists "only a team's own verified captain manages its officers" on team_officers;
create policy "only a team's own verified captain manages its officers" on team_officers
  for all
  using (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_officers.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_officers.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  );

-- Team settings: discord_invite_url + team_emoji are the only two
-- `teams` columns a captain edits directly through the site - every
-- other column on this table is Nitro Type's own truth, overwritten by
-- the next sync, so letting a captain edit those would just be
-- undone within 30 minutes. These two are shown on the team's public
-- page (an invite link racers can actually join through) and next to
-- the team's name on leaderboards (the emoji), the same idea as
-- Startrack's own Settings tab.
alter table teams add column if not exists discord_invite_url text;
alter table teams add column if not exists team_emoji text;

-- teams had NO row level security at all until now. Combined with the
-- blanket "grant insert, update, delete ... to authenticated" at the
-- bottom of this file, that meant ANY signed-in session (including the
-- short-lived anonymous one the connect-flow creates) could already
-- rewrite or delete any team's row via the REST API - nothing client-
-- side ever exercised that path, but it was open. Turning RLS on here
-- closes it: a public read policy keeps every existing read working,
-- and the update policy below (same ownership check as events/
-- team_officers) plus a column-scoped grant make the only remaining
-- write a team's own verified captain changing their own two settings
-- columns - inserts and deletes are denied outright (no policy allows
-- them once RLS is on, regardless of the blanket grant).
alter table teams enable row level security;

drop policy if exists "teams are publicly readable" on teams;
create policy "teams are publicly readable" on teams
  for select using (true);

drop policy if exists "only a team's own verified captain edits its settings" on teams;
create policy "only a team's own verified captain edits its settings" on teams
  for update
  using (
    exists (
      select 1 from account_links al
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = teams.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1 from account_links al
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = teams.captain_nt_user_id
    )
  );

-- Squads: a captain's own sub-groups within their team (StarTrack's
-- "Squads" tab) - just a name + color, with each racer optionally
-- belonging to one. Nothing scoring-related reads this; it's purely
-- organizational (roster badges, eventually squad-filtered views).
create table if not exists team_squads (
  id         bigserial primary key,
  team_tag   text not null references teams(tag) on delete cascade,
  name       text not null,
  -- "#rrggbb", captain-picked via a native color input - no palette to
  -- maintain, and it reads back straight into a CSS background/border.
  color      text not null default '#29d3ff',
  created_at timestamptz not null default now(),
  unique (team_tag, name)
);

alter table team_squads enable row level security;

-- Readable by anyone (squad badges show up on the public roster); only
-- that team's own verified captain creates/renames/recolors/deletes
-- squads - the same ownership check as team_officers/teams above.
drop policy if exists "team_squads are publicly readable" on team_squads;
create policy "team_squads are publicly readable" on team_squads
  for select using (true);

drop policy if exists "only a team's own verified captain manages its squads" on team_squads;
create policy "only a team's own verified captain manages its squads" on team_squads
  for all
  using (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_squads.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_squads.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  );

alter table racers add column if not exists squad_id bigint references team_squads(id) on delete set null;

-- racers had NO row level security at all until now - the exact same gap
-- teams had (see the comment above teams' "enable row level security"):
-- combined with the blanket "insert, update, delete ... to authenticated"
-- grant at the bottom of this file, ANY signed-in session could already
-- rewrite or delete ANY racer's row via the REST API. Turning RLS on here
-- closes it the same way: public read keeps every existing read working,
-- and the update policy below (same ownership check as everything else
-- above) plus a column-scoped grant make the only remaining write a
-- team's own verified captain re-assigning one of their own racers to a
-- different squad - every other racers column stays Nitro Type's own
-- truth, overwritten by the next sync regardless. Inserts/deletes are
-- denied outright (those only ever happen via the sync job's
-- service-role key, which bypasses RLS entirely).
alter table racers enable row level security;

drop policy if exists "racers are publicly readable" on racers;
create policy "racers are publicly readable" on racers
  for select using (true);

drop policy if exists "only a racer's own team's verified captain assigns its squad" on racers;
create policy "only a racer's own team's verified captain assigns its squad" on racers
  for update
  using (
    exists (
      select 1 from account_links al
      join teams t on t.tag = racers.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1 from account_links al
      join teams t on t.tag = racers.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  );

-- Tournaments: a named, dated bracket a captain schedules, owned (for RLS
-- purposes) by team_tag but able to span several participating teams (see
-- tournament_teams below) - matches StarTrack's own real tournament
-- feature: a multi-round single-elimination bracket (Seeding, Round of 64,
-- ... Championship), scored by a chosen field (points/races/avg speed/
-- accuracy) aggregated from the racer_points ledger over each round's own
-- [start,end] window, with an optional minimum-races-per-round gate. There
-- is still no real per-race match data (Nitro Type's API doesn't expose
-- individual races), but a round-windowed aggregate comparison between two
-- seeded entrants is an honest, defensible stand-in for "who won this
-- round" - see src/tournaments-data.js's buildBracket, which computes the
-- whole bracket (seeding + every round's matches + winners) live from this
-- table + tournament_teams + tournament_rounds; nothing about who's
-- seeded or who won a round is stored anywhere.
create table if not exists team_tournaments (
  id          bigserial primary key,
  team_tag    text not null references teams(tag) on delete cascade,
  title       text not null,
  description text,
  start_stamp timestamptz not null,
  end_stamp   timestamptz not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists team_tournaments_team_time on team_tournaments (team_tag, start_stamp desc);

alter table team_tournaments enable row level security;

drop policy if exists "team_tournaments are publicly readable" on team_tournaments;
create policy "team_tournaments are publicly readable" on team_tournaments
  for select using (true);

drop policy if exists "only a team's own verified captain manages its tournaments" on team_tournaments;
create policy "only a team's own verified captain manages its tournaments" on team_tournaments
  for all
  using (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_tournaments.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  )
  with check (
    exists (
      select 1
      from account_links al
      join teams t on t.tag = team_tournaments.team_tag
      where al.auth_user_id = auth.uid()
        and al.nt_user_id = t.captain_nt_user_id
    )
  );

-- Bracket migration: scoring_field/qualifying_races on the tournament
-- itself, plus the two tables that make a tournament a real bracket -
-- tournament_teams (which teams' racers are eligible entrants; the owning
-- team_tag from team_tournaments is not auto-included, so add it too if it
-- should race) and tournament_rounds (the round schedule - Seeding then
-- however many elimination rounds the captain configures, each with its
-- own [start_stamp, end_stamp]). Both are owned/RLS-gated the same way as
-- team_tournaments itself, keyed off tournament_id -> team_tournaments.
-- team_tag -> that team's real captain, so only the tournament's own
-- creator-team captain can edit its teams/rounds - never a participating
-- team that isn't the owner.
alter table team_tournaments add column if not exists scoring_field text not null default 'points';
alter table team_tournaments add column if not exists qualifying_races integer not null default 0;

create table if not exists tournament_teams (
  tournament_id bigint not null references team_tournaments(id) on delete cascade,
  team_tag      text not null references teams(tag) on delete cascade,
  primary key (tournament_id, team_tag)
);

create table if not exists tournament_rounds (
  id            bigserial primary key,
  tournament_id bigint not null references team_tournaments(id) on delete cascade,
  round_key     text not null,
  round_order   integer not null,
  label         text not null,
  start_stamp   timestamptz not null,
  end_stamp     timestamptz not null,
  unique (tournament_id, round_key)
);

create index if not exists tournament_rounds_tournament on tournament_rounds (tournament_id, round_order);

alter table tournament_teams enable row level security;
alter table tournament_rounds enable row level security;

drop policy if exists "tournament_teams are publicly readable" on tournament_teams;
create policy "tournament_teams are publicly readable" on tournament_teams
  for select using (true);

drop policy if exists "only a tournament's own creator-team captain manages its teams" on tournament_teams;
create policy "only a tournament's own creator-team captain manages its teams" on tournament_teams
  for all
  using (
    exists (
      select 1
      from team_tournaments tt
      join teams t on t.tag = tt.team_tag
      join account_links al on al.nt_user_id = t.captain_nt_user_id
      where tt.id = tournament_teams.tournament_id
        and al.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from team_tournaments tt
      join teams t on t.tag = tt.team_tag
      join account_links al on al.nt_user_id = t.captain_nt_user_id
      where tt.id = tournament_teams.tournament_id
        and al.auth_user_id = auth.uid()
    )
  );

drop policy if exists "tournament_rounds are publicly readable" on tournament_rounds;
create policy "tournament_rounds are publicly readable" on tournament_rounds
  for select using (true);

drop policy if exists "only a tournament's own creator-team captain manages its rounds" on tournament_rounds;
create policy "only a tournament's own creator-team captain manages its rounds" on tournament_rounds
  for all
  using (
    exists (
      select 1
      from team_tournaments tt
      join teams t on t.tag = tt.team_tag
      join account_links al on al.nt_user_id = t.captain_nt_user_id
      where tt.id = tournament_rounds.tournament_id
        and al.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from team_tournaments tt
      join teams t on t.tag = tt.team_tag
      join account_links al on al.nt_user_id = t.captain_nt_user_id
      where tt.id = tournament_rounds.tournament_id
        and al.auth_user_id = auth.uid()
    )
  );

-- Profiles: the display identity for a TypeTrack account, separate from
-- its Supabase Auth email (which, per the connect-flow redesign, is a
-- synthetic address the user never sees or picks - see src/client/app.js).
-- A regular team member or non-member picks their own chosen_username at
-- signup; a captain or officer instead goes by their real Nitro Type
-- display name (chosen_username stays null for them and the UI falls back
-- to account_links -> racers.display_name). Row is created by the owning
-- user themselves right after they verify ownership, which is why insert
-- is allowed for "your own row" rather than only by a service role.
create table if not exists profiles (
  auth_user_id    uuid primary key references auth.users(id) on delete cascade,
  chosen_username text unique,
  created_at      timestamptz not null default now()
);

alter table profiles enable row level security;

-- Publicly readable (account names show up all over the site); a user may
-- only ever insert/update their OWN row, never anyone else's.
drop policy if exists "profiles are publicly readable" on profiles;
create policy "profiles are publicly readable" on profiles
  for select using (true);

drop policy if exists "a user manages only their own profile" on profiles;
create policy "a user manages only their own profile" on profiles
  for insert with check (auth_user_id = auth.uid());

drop policy if exists "a user updates only their own profile" on profiles;
create policy "a user updates only their own profile" on profiles
  for update using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

-- Table-level GRANTs - without these, RLS above is never even reached:
-- PostgREST checks role-level GRANTs first, and running this file through
-- the SQL Editor (vs. creating tables through the dashboard's Table
-- Editor, which auto-grants) does NOT grant anything by itself. Re-run
-- (idempotent) any time a new table is added above.
--
-- service_role is included here too, not just anon/authenticated:
-- verified directly via information_schema.role_table_grants that this
-- project's service_role had the SAME gap (only REFERENCES/TRIGGER/
-- TRUNCATE, no SELECT/INSERT/UPDATE/DELETE) on at least `racers` - it
-- bypasses Row Level Security, not table-level GRANTs, and a table
-- created by raw SQL here never got service_role's grants either. This
-- is exactly what was breaking verify-car-swap's Edge Function (which
-- reads/writes via the service-role key) with "Lookup failed, try
-- again." even after anon/authenticated were fixed.
grant select on all tables in schema public to anon, authenticated, service_role;
grant insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant select on tables to anon, authenticated, service_role;
alter default privileges in schema public grant insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;

-- teams is the one exception to the blanket "insert, update, delete ...
-- to authenticated" two lines up: that grant would otherwise let a
-- signed-in captain UPDATE any column on their own team's row
-- (tag_color, min_races, even captain_nt_user_id), not just the two
-- settings columns the RLS policy above is meant to allow, and would
-- let ANY signed-in session insert or delete team rows outright. Narrow
-- it back down to exactly what the Settings tab needs - this has to run
-- after the blanket grant above (same idempotent-script ordering this
-- whole file already depends on), or the blanket grant would simply
-- re-widen it on the next run.
revoke insert, update, delete on teams from authenticated;
grant update (discord_invite_url, team_emoji) on teams to authenticated;

-- Same narrowing for racers: the RLS update policy above is meant to let
-- a captain change only squad_id on their own team's racers, not every
-- other NT-sourced column (role, car_id, display_name, ...) and
-- definitely not insert/delete rows outright. team_squads itself needs
-- no equivalent narrowing - a captain legitimately owns the full
-- insert/update/delete lifecycle of their own squads, which is exactly
-- what its "for all" RLS policy above already scopes to their team.
revoke insert, update, delete on racers from authenticated;
grant update (squad_id) on racers to authenticated;
