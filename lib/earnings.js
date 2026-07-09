// ── EARNINGS CALENDAR ──
// Finnhub's calendar/earnings endpoint, scoped to one ticker + a lookahead window — not called
// anywhere in the core scan/monitoring pipeline before this. Used by two callers: the scan report
// (lib/stockAnalysis.js, via handleStockAnalysis) for "next earnings: [date]" display, and the
// daily monitoring cron (api/check-market-alerts.js) for the earnings_upcoming notification.
//
// Deliberately separate from api/weekly-digest.js's own earnings lookup (added for its digest
// narrative in an earlier task) rather than shared — that's a working, already-tested Agent
// feature this task is scoped to leave untouched, so a small amount of duplication here is the
// safer tradeoff over touching it.

const DEFAULT_LOOKAHEAD_DAYS = 90; // generous window for "next earnings" display on a scan report
                                    // — a company may not report again for ~3 months

const SESSION_LABELS = { bmo: 'before market open', amc: 'after market close', dmh: 'during market hours' };

export function earningsSessionLabel(hour) {
  return SESSION_LABELS[hour] || null;
}

// Returns { date: 'YYYY-MM-DD', hour: 'bmo'|'amc'|'dmh'|null } for the next scheduled earnings
// report within the lookahead window, or null if there isn't one / the call fails. Best-effort —
// never throws, matching the rest of this codebase's Finnhub-call conventions (e.g.
// lib/stockAnalysis.js's fetchCompetitors).
export async function fetchNextEarningsDate(finnhubKey, ticker, lookaheadDays = DEFAULT_LOOKAHEAD_DAYS) {
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    const upcoming = Array.isArray(data?.earningsCalendar)
      ? data.earningsCalendar.filter(e => e?.date).sort((a, b) => a.date.localeCompare(b.date))[0]
      : null;
    return upcoming ? { date: upcoming.date, hour: upcoming.hour || null } : null;
  } catch {
    return null;
  }
}
