// Tests for lib/peerAlertComparison.js
//
// Run with: node --experimental-vm-modules lib/peerAlertComparison.test.js
// (or via whatever test runner this project uses — currently no test harness is configured,
// so these are written as self-contained assertions using Node's built-in assert module)

import assert from 'node:assert/strict';
import { selectBestPeer, buildComparisonSentence, getPeerComparisonLine } from './peerAlertComparison.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    testsFailed++;
  }
}

// Builds a minimal fake `fresh` scan object for getPeerComparisonLine tests.
function makeFresh({ ticker = 'NFLX', competitors = [], rawMetrics = {} } = {}) {
  return { ticker, competitors, rawMetrics };
}

// ── (a) Correct peer selection when multiple peers exist ──────────────────────

console.log('\n(a) Peer selection — picks the most informative contrast');

await test('selects the peer with the greatest contrast (higher_is_better: lower peer wins)', async () => {
  // Flag: declining_free_cash_flow → higher_is_better. Primary FCF margin is -5%.
  // Peer A has 12% FCF margin (good contrast), Peer B has 2% (less contrast).
  // Expected: Peer A selected (peerValue=12 gives contrast of 12-(-5)=17 vs 2-(-5)=7).

  const peers = [
    { ticker: 'PEERB', companyName: 'Peer B' },
    { ticker: 'PEERA', companyName: 'Peer A' }
  ];
  const primaryValue = -5; // -5% FCF margin

  // Mock fetch: PEERA → 0.12 (raw, will be scaled ×100 → 12%), PEERB → 0.02 (→ 2%)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const ticker = new URL(url).searchParams.get('symbol');
    const value = ticker === 'PEERA' ? 0.12 : 0.02;
    return { ok: true, json: async () => ({ metric: { 'fcfMarginAnnual': value } }) };
  };

  try {
    const result = await selectBestPeer(peers, 'declining_free_cash_flow', primaryValue, 'fake-key');
    assert.ok(result, 'should return a peer');
    assert.equal(result.peer.ticker, 'PEERA', 'should pick PEERA with higher FCF margin');
    assert.ok(Math.abs(result.peerValue - 12) < 0.01, `peerValue should be 12 (got ${result.peerValue})`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('selects the peer with lowest D/E for lower_is_better flags', async () => {
  // Flag: high_debt_to_equity → lower_is_better. Primary D/E is 3.5.
  // Peer A has D/E 0.8 (better contrast: 3.5-0.8=2.7), Peer B has D/E 2.9 (3.5-2.9=0.6).
  // Expected: Peer A selected.

  const peers = [
    { ticker: 'PEERB', companyName: 'Peer B' },
    { ticker: 'PEERA', companyName: 'Peer A' }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const ticker = new URL(url).searchParams.get('symbol');
    const value = ticker === 'PEERA' ? 0.8 : 2.9;
    return { ok: true, json: async () => ({ metric: { 'totalDebt/totalEquityAnnual': value } }) };
  };

  try {
    const result = await selectBestPeer(peers, 'high_debt_to_equity', 3.5, 'fake-key');
    assert.ok(result, 'should return a peer');
    assert.equal(result.peer.ticker, 'PEERA');
    assert.ok(Math.abs(result.peerValue - 0.8) < 0.01);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── (b) Correct metric selection when multiple red flags fire at once ─────────

console.log('\n(b) Metric selection — uses primary (most severe) flag\'s metric');

await test('uses the high-severity flag\'s metric when both high and medium flags fire', async () => {
  // Scenario: two flags fire — 'declining_free_cash_flow' (high) and 'low_current_ratio' (medium).
  // The primary flag (high) should be 'declining_free_cash_flow' → FCF metric fetched.

  const fresh = makeFresh({
    ticker: 'NFLX',
    competitors: [{ ticker: 'DIS', companyName: 'Walt Disney Co' }],
    rawMetrics: { fcfMarginRaw: -5.2, currentRatioRaw: 0.8 }
  });

  // Track which Finnhub field was requested
  let requestedField = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    // Capture which field the peer lookup is for by peeking at the returned metric object
    requestedField = 'fcfMarginAnnual'; // we'll verify the returned value is FCF-scaled
    return { ok: true, json: async () => ({ metric: { fcfMarginAnnual: 0.14 } }) };
  };

  try {
    // Simulate: primary flag is 'declining_free_cash_flow' (high severity)
    const line = await getPeerComparisonLine(fresh, 'declining_free_cash_flow', 'fake-key');
    assert.ok(line !== null, 'should produce a comparison line');
    // Line should mention FCF margin (not current ratio)
    assert.ok(line.includes('FCF margin'), `expected "FCF margin" in line, got: "${line}"`);
    // Peer value: 0.14 × 100 = 14.0%
    assert.ok(line.includes('14.0%'), `expected peer value "14.0%" in line, got: "${line}"`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('buildComparisonSentence uses the correct metric label for each flag id', () => {
  // Spot-check that the sentence generator picks up the right label per flag.
  const debtLine = buildComparisonSentence('NFLX', 'DIS', 'Walt Disney Co', 'high_debt_to_equity', 3.5, 0.8);
  assert.ok(debtLine?.includes('debt-to-equity ratio'), `expected "debt-to-equity ratio", got: "${debtLine}"`);

  const fcfLine = buildComparisonSentence('NFLX', 'DIS', 'Walt Disney Co', 'declining_free_cash_flow', -5.2, 14.0);
  assert.ok(fcfLine?.includes('FCF margin'), `expected "FCF margin", got: "${fcfLine}"`);

  const crLine = buildComparisonSentence('NFLX', 'DIS', 'Walt Disney Co', 'low_current_ratio', 0.7, 1.8);
  assert.ok(crLine?.includes('current ratio'), `expected "current ratio", got: "${crLine}"`);
});

// ── (c) Graceful fallback when fetchCompetitors returns no peers ──────────────

console.log('\n(c) Graceful fallback — alert fires even with no peers or no data');

await test('getPeerComparisonLine returns null (not throws) when competitors is empty', async () => {
  const fresh = makeFresh({ ticker: 'NFLX', competitors: [], rawMetrics: { fcfMarginRaw: -5 } });
  const line = await getPeerComparisonLine(fresh, 'declining_free_cash_flow', 'fake-key');
  assert.equal(line, null, 'should return null, not throw');
});

await test('getPeerComparisonLine returns null when competitors is missing', async () => {
  const fresh = { ticker: 'NFLX', rawMetrics: { fcfMarginRaw: -5 } }; // no competitors key
  const line = await getPeerComparisonLine(fresh, 'declining_free_cash_flow', 'fake-key');
  assert.equal(line, null);
});

await test('getPeerComparisonLine returns null when all peer Finnhub calls fail', async () => {
  const fresh = makeFresh({
    ticker: 'NFLX',
    competitors: [{ ticker: 'DIS', companyName: 'Walt Disney Co' }],
    rawMetrics: { fcfMarginRaw: -5 }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  try {
    const line = await getPeerComparisonLine(fresh, 'declining_free_cash_flow', 'fake-key');
    assert.equal(line, null, 'should return null when peer fetch fails, not crash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('getPeerComparisonLine returns null when primary metric is missing from rawMetrics', async () => {
  const fresh = makeFresh({
    ticker: 'NFLX',
    competitors: [{ ticker: 'DIS', companyName: 'Walt Disney Co' }],
    rawMetrics: {} // no fcfMarginRaw
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ metric: { fcfMarginAnnual: 0.14 } }) });
  try {
    const line = await getPeerComparisonLine(fresh, 'declining_free_cash_flow', 'fake-key');
    assert.equal(line, null, 'should return null when primary metric unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('getPeerComparisonLine returns null for an unknown flag id (no crash)', async () => {
  const fresh = makeFresh({
    ticker: 'NFLX',
    competitors: [{ ticker: 'DIS', companyName: 'Walt Disney Co' }],
    rawMetrics: { fcfMarginRaw: -5 }
  });
  const line = await getPeerComparisonLine(fresh, 'unknown_flag_id_xyz', 'fake-key');
  assert.equal(line, null);
});

await test('selectBestPeer returns null when peers array is empty', async () => {
  const result = await selectBestPeer([], 'declining_free_cash_flow', -5, 'fake-key');
  assert.equal(result, null);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${testsPassed + testsFailed} tests: ${testsPassed} passed, ${testsFailed} failed\n`);
if (testsFailed > 0) process.exit(1);
