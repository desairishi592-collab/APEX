// ── RED FLAG "WHAT TO CHECK NEXT" ──
// Static lookup table keyed by lib/redFlags.js's stable flag `id` — one or two concrete, specific
// next actions per flag type. Zero new data, zero LLM calls: pure hand-written text, always
// available instantly (unlike lib/agentChecklist.js's Groq-generated per-alert checklist, which
// is richer/tailored to the exact numbers involved but best-effort and can fail or be skipped).
// This is the guaranteed baseline shown inline on the scan report (where no notification/Groq
// call happens at all) and folded into the notification body alongside that richer checklist —
// see lib/scoreMonitor.js's decideAlerts() and index.html's red-flag rendering.
//
// REGULATORY CONSTRAINT: strictly informational — "check X" / "compare Y," never "you should
// sell" or a personalized recommendation. Same posture as lib/agentChecklist.js elsewhere.
const RED_FLAG_ACTIONS = {
  high_debt_to_equity: "Check the company's latest 10-Q or 10-K for its debt maturity schedule and interest rate terms, and compare its debt/equity ratio to its 2-3 closest sector peers to see whether this is company-specific or sector-wide.",
  declining_free_cash_flow: 'Check whether the decline is capex-driven (e.g. a stated growth or expansion investment) or a genuine drop in operating cash generation — the "investing activities" section of the two most recent quarterly cash flow statements usually spells out the difference.',
  insider_selling_spike: 'Check the next 8-K or earnings call for context on the sale — scheduled 10b5-1 plan sales read very differently than opportunistic open-market selling, and the filing will usually specify which.',
  declining_revenue_trend: "Check the most recent earnings call transcript for management's own explanation of the decline (a specific segment, a competitive loss, or a broader macro/industry slowdown), and compare the trend against 1-2 direct competitors over the same period.",
  low_current_ratio: "Check the balance sheet's cash and short-term investments line specifically, not just the ratio itself — a company can run a low current ratio comfortably if it holds substantial cash reserves or has predictable, recurring cash inflows."
};

// Returns the static action text for a flag id, or null if unrecognized — a future flag type
// added to lib/redFlags.js without a corresponding entry here degrades to "no text shown," never
// a fabricated generic message.
export function getRedFlagAction(flagId) {
  return RED_FLAG_ACTIONS[flagId] || null;
}
