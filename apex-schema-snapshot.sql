-- APEX Supabase schema snapshot — REVERSE-ENGINEERED, READ-ONLY.
--
-- Generated 2026-07-15 by querying APEX's live Supabase project (agvwyqslzreqtnmmwxwk)
-- directly via PostgREST's schema introspection endpoint:
--
--   GET https://agvwyqslzreqtnmmwxwk.supabase.co/rest/v1/
--   Accept: application/openapi+json
--   (requires the service_role/secret key — the publishable/anon key is rejected for this route)
--
-- This reflects the ACTUAL live schema at the time of the query — not the migrations/ folder,
-- which only has one file (watch_conditions.sql) and is otherwise incomplete/stale relative to
-- what's actually deployed. This file exists because APEX has never had a checked-in schema.sql;
-- treat this as a point-in-time snapshot to keep re-generating (via the same curl call) rather
-- than a source of truth to hand-edit — it will drift the moment a column is added in the
-- Supabase dashboard without a matching migration.
--
-- CAVEATS (real limits of this method, be aware before relying on this doc):
--   1. Column types/nullability/defaults/PKs are accurate (taken directly from Postgres via
--      PostgREST's introspection). Foreign keys are only annotated by PostgREST when both sides
--      of the FK are in the introspected ("public") schema — a user_id column referencing
--      auth.users(id) will NOT show an <fk/> annotation here even if the constraint exists,
--      because auth.users lives in a different schema. Only referrals.referrer_id/referred_id
--      (which point at public.profiles) show up as FKs below; every user_id column almost
--      certainly has a real FK to auth.users(id) (matching the one confirmed migration file's
--      pattern for watch_conditions), it's just not visible through this introspection method.
--   2. RLS policies (USING/WITH CHECK clauses) are NOT visible through this method at all — the
--      one exception is watch_conditions, where the actual policies are known because
--      migrations/watch_conditions.sql exists in the repo and is quoted verbatim in the findings
--      doc. For every other table below, RLS enablement/policy text is unconfirmed.
--   3. Indexes are not visible through this method either.
--   4. No comments/descriptions exist in the live DB for these tables (nothing to carry over).
--
-- See findings doc for the side-by-side diff against Nexus's portfolio_holdings and the
-- identity-bridge discussion.

-- ── profiles ──
-- One row per APEX user, PK'd on auth.users.id (same convention as Nexus's user_settings/
-- personal_financial_profiles: id doubles as both PK and implicit FK to auth.users).
-- NOTE: contrary to a comment in api/stripe-webhook.js ("profiles has no email column (email
-- lives on auth.users)"), the live table DOES have an `email` column — see findings doc.
create table public.profiles (
  id uuid primary key,                                    -- not null; presumed FK to auth.users(id) (not introspectable, see caveat 1)
  email text not null,
  plan text default 'free',
  stripe_customer_id text,
  created_at timestamptz default (timezone('utc'::text, now())),
  scan_count integer default 0,
  scan_limit_hit_at timestamptz,
  referral_code text,
  bonus_scans integer not null default 0
);

-- ── portfolio_holdings ──
-- APEX's equivalent of Nexus's portfolio_holdings. See findings doc for the full diff — key
-- differences: purchase_price (not cost_basis, and NOT NULL/required here vs nullable+optional
-- in Nexus), plus score/safety_score/signal columns Nexus's table doesn't have at all.
create table public.portfolio_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                                  -- presumed FK to auth.users(id), see caveat 1
  ticker text not null,
  company_name text,
  shares numeric not null,
  purchase_price numeric not null,                        -- per-share; required (Nexus's cost_basis is optional)
  created_at timestamptz not null default now(),
  score integer,                                           -- APEX score snapshot at time of add/last refresh
  safety_score integer,
  signal text
);

-- ── watchlist ──
create table public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  ticker text not null,
  company_name text,
  score integer,
  safety_score integer,
  signal text,
  created_at timestamptz not null default now()
  -- unique(user_id, ticker) presumed from the app's .upsert(..., { onConflict: 'user_id,ticker' })
  -- call, not independently confirmed via this introspection method.
);

-- ── price_alerts ──
create table public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email text not null,                                    -- denormalized copy of the user's email at alert-creation time
  ticker text not null,
  company_name text,
  target_price numeric not null,
  price_at_creation numeric,
  signal_at_creation text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  triggered_at timestamptz,
  notified_at timestamptz
);

-- ── watch_conditions ──
-- Matches migrations/watch_conditions.sql exactly (that file's own create-table statement is the
-- authoritative source for this one, including its RLS policies — reproduced here for completeness).
create table public.watch_conditions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  company_name text,
  metric text not null check (metric in ('score', 'pe_ratio', 'debt_equity', 'current_ratio', 'roe', 'profit_margin', 'safety_score')),
  operator text not null check (operator in ('above', 'below')),
  threshold numeric not null,
  active boolean not null default true,
  triggered_at timestamptz,
  triggered_value numeric,
  created_at timestamptz not null default now()
);

-- ── notifications ──
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text not null,
  ticker text,
  company_name text,
  title text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── scans ──
-- APEX's core "health scan" history (both stock/investor-mode and business/owner-mode scans).
create table public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  business_name text,
  industry text,
  score integer,
  status text,
  full_data jsonb,                                        -- full scan payload; ticker (for stock scans) lives inside this blob, not a top-level column
  created_at timestamptz default now(),
  mode text default 'owner'                                -- 'owner' | 'investor'
);

-- ── api_keys ──
-- APEX's CLI/API-key table. Compare to Nexus's api_keys (findings doc) — APEX has no `name` or
-- `last_used_at` columns.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key_hash text not null,
  key_prefix text not null,
  created_at timestamptz not null default now()
);

-- ── referrals ──
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id),
  referred_id uuid not null references public.profiles(id),
  converted boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── api_rate_limits / ip_rate_limits ──
-- Rate limiting for authenticated API-key requests and anonymous/IP-based requests respectively.
create table public.api_rate_limits (
  user_id uuid primary key,
  window_start timestamptz not null default now(),
  request_count integer not null default 0
);

create table public.ip_rate_limits (
  ip text primary key,
  window_start timestamptz not null default now(),
  request_count integer not null default 0
);

-- ── peer_scan_cache ──
-- Shared (not per-user) cache of peer-comparison data, keyed only by ticker.
create table public.peer_scan_cache (
  ticker text primary key,
  company_name text,
  score integer,
  sub_scores jsonb,
  pe_ratio numeric,
  debt_equity numeric,
  cached_at timestamptz not null default now()
);
