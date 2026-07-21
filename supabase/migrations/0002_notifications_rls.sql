-- Fixes the Alerts tab (and the APEX Agent page / Home "Latest Alerts" preview) showing nothing
-- even though the weekly digest and daily monitoring crons are writing rows. All writers
-- (lib/notifications.js's createNotification(), used by lib/scoreMonitor.js,
-- lib/concentrationMonitor.js, lib/watchConditions.js, api/check-market-alerts.js, and
-- api/weekly-digest.js) use the Supabase service-role key, which bypasses RLS entirely — so
-- writes have been succeeding all along. But every client-side read (index.html's `sb` client,
-- using the logged-in user's own session + the anon key) goes through PostgREST, which is
-- subject to RLS. This table was never given the enable-RLS + policy migration that
-- watch_conditions/watchlist/portfolio_holdings/price_alerts already have (see
-- 0001_watch_conditions.sql for the same pattern) — with RLS off, this would normally allow
-- read/write from anyone with the anon key, but if it was ever toggled on in the dashboard
-- without matching policies, PostgREST default-denies every row, which is the most likely
-- explanation for "the crons run, rows exist, but the Alerts tab shows nothing." This migration
-- makes that state explicit and correct either way: RLS on, with policies that scope every
-- client-side read/write to the caller's own notifications. Run this once in the Supabase SQL
-- editor.

alter table public.notifications enable row level security;

create policy "Users can view their own notifications"
  on public.notifications for select
  using (auth.uid() = user_id);

-- index.html's markNotificationsRead-style calls do
-- `.from('notifications').update({ read: true }).in('id', unreadIds).eq('user_id', currentUser.id)`
-- — this is the only client-side write against this table today.
create policy "Users can mark their own notifications read"
  on public.notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
