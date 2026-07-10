-- Watch conditions: user-defined APEX Agent alert thresholds (e.g. "alert me if AAPL's P/E
-- crosses 35"). Run this once in the Supabase SQL editor.
--
-- `metric` and `operator` are constrained to the exact set lib/watchConditions.js and
-- index.html's watch-condition wizard both know how to evaluate/display — keep the three in sync
-- if this set ever changes.
--
-- Dedup/re-arm model mirrors the existing `price_alerts` table: a triggered condition flips
-- `active` to false so it naturally drops out of the cron's `active = true` query and never
-- re-fires; editing a condition in the UI resets `active` to true and clears `triggered_at` /
-- `triggered_value` to re-arm it.

create table if not exists public.watch_conditions (
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

-- Cron's main query is `active = eq.true` across ALL users; user-facing reads/writes are always
-- scoped to one user_id.
create index if not exists watch_conditions_active_idx on public.watch_conditions (active) where active = true;
create index if not exists watch_conditions_user_id_idx on public.watch_conditions (user_id);

alter table public.watch_conditions enable row level security;

-- The cron (api/check-market-alerts.js) uses the service-role key, which bypasses RLS entirely —
-- these policies only govern the user-facing client-side reads/writes (index.html, via the
-- logged-in user's own session token), same pattern as watchlist/portfolio_holdings/price_alerts.
create policy "Users can view their own watch conditions"
  on public.watch_conditions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own watch conditions"
  on public.watch_conditions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own watch conditions"
  on public.watch_conditions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own watch conditions"
  on public.watch_conditions for delete
  using (auth.uid() = user_id);
