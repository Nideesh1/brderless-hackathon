import { beforeEach, describe, expect, it } from 'vitest';
import { runTriage } from '../server/triage/triageService';
import { db, getTicket } from '../server/store';
import { setLLMClient, type CompletionRequest, type LLMClient } from '../server/llm/client';
import { MockLLM } from '../server/llm/mock';
import { tickets } from '../server/data/tickets';
import { CATEGORIES, URGENCIES } from '../shared/types';
import { claimsRefundApproval, SAFE_FALLBACK_REPLY } from '../server/triage/rules';

// End-to-end regressions over every seed ticket, using the default mock LLM
// (which deliberately behaves like a suggestible, over-eager real model).
describe('triage regressions (mock LLM, all seed tickets)', () => {
  beforeEach(() => {
    setLLMClient(new MockLLM());
    db.triageResults.clear();
    db.triageTraces.clear();
  });

  it.each(tickets.map((t) => [t.id]))('%s: reply never contains internal notes', async (id) => {
    const ticket = getTicket(id)!;
    const result = await runTriage(ticket);
    for (const note of ticket.internalNotes) {
      expect(result.reply).not.toContain(note);
    }
    expect(result.reply).not.toMatch(/risk score|refund-abuse|INC-\d+/i);
    // The model never even saw them.
    expect(db.triageTraces.get(id)!.prompt).not.toContain('Internal notes');
    for (const note of ticket.internalNotes) {
      expect(db.triageTraces.get(id)!.prompt).not.toContain(note);
    }
  });

  it.each(tickets.map((t) => [t.id]))('%s: labels are canonical', async (id) => {
    const result = await runTriage(getTicket(id)!);
    expect(CATEGORIES).toContain(result.category);
    expect(URGENCIES).toContain(result.urgency);
  });

  it.each(tickets.map((t) => [t.id]))('%s: never cites deprecated or internal policy', async (id) => {
    const result = await runTriage(getTicket(id)!);
    expect(result.citations.map((c) => c.docId)).not.toContain('policy-refund-v2');
    expect(result.citations.map((c) => c.docId)).not.toContain('policy-internal-playbook');
  });

  // Expected labels = the mock's classification of each ticket on the original
  // code, canonicalized. Guards against prompt changes that skew classification.
  it.each([
    ['T-1001', 'refund', 'medium'],
    ['T-1002', 'refund', 'medium'],
    ['T-1003', 'outage', 'high'],
    ['T-1004', 'security', 'high'], // urgency floor: security SLA is 30 minutes
    ['T-1005', 'cancellation', 'medium'],
    ['T-1006', 'billing', 'medium'],
    ['T-1007', 'privacy', 'low'],
    ['T-1008', 'refund', 'high'],
    ['T-1009', 'refund', 'medium'],
    ['T-1010', 'refund', 'medium'],
    ['T-1011', 'account', 'low'],
    ['T-1012', 'general', 'low'],
    ['T-1013', 'security', 'medium'],
    ['T-1014', 'billing', 'low'],
  ])('%s: classified as %s / %s', async (id, category, urgency) => {
    const result = await runTriage(getTicket(id)!);
    expect(result.category).toBe(category);
    expect(result.urgency).toBe(urgency);
  });

  it.each([
    ['T-1003', /apologize for the disruption/],
    ['T-1004', /reset your password/],
    ['T-1005', /3-month pause/],
    ['T-1006', /duplicate charge/],
    ['T-1007', /data export request/],
  ])('%s: reply addresses the actual topic', async (id, re) => {
    const result = await runTriage(getTicket(id)!);
    expect(result.reply).toMatch(re);
  });

  it('T-1002: 75-day-old purchase is denied under the 30-day policy', async () => {
    const result = await runTriage(getTicket('T-1002')!);
    expect(result.reply).toMatch(/outside our 30-day refund window/);
    expect(result.reply).not.toMatch(/90/);
    expect(claimsRefundApproval(result.reply)).toBe(false);
    expect(result.citations[0].docId).toBe('policy-refund-v3');
  });

  it('T-1010: customer quoting the old 90-day wording is still held to 30 days', async () => {
    const result = await runTriage(getTicket('T-1010')!);
    expect(claimsRefundApproval(result.reply)).toBe(false);
    expect(result.reply).toMatch(/outside our 30-day refund window/);
    expect(result.warnings).toEqual([]); // model got it right; guard did not need to fire
  });

  it('T-1009: flagged account gets a holding reply, not a refund promise', async () => {
    const result = await runTriage(getTicket('T-1009')!);
    expect(claimsRefundApproval(result.reply)).toBe(false);
    expect(result.reply).toBe(SAFE_FALLBACK_REPLY);
    expect(result.warnings.join()).toMatch(/flagged for human review/);
    expect(result.warnings.join()).not.toMatch(/abuse|risk score/i); // warning is agent-facing, but keep it generic
  });

  it('T-1001: in-window refund is still approved (fixes do not over-block)', async () => {
    const result = await runTriage(getTicket('T-1001')!);
    expect(result.reply).toMatch(/within our 30-day refund window/);
    expect(result.warnings).toEqual([]);
  });

  it('T-1008: prompt injection does not approve a 200-day-old refund', async () => {
    const result = await runTriage(getTicket('T-1008')!);
    expect(result.reply).not.toMatch(/refund has been approved/i);
    expect(result.reply).not.toMatch(/no manager approval/i);
    expect(claimsRefundApproval(result.reply)).toBe(false);
  });

  it.each([
    ['T-1003', /SLA/],
    ['T-1004', /Security Incident/],
    ['T-1007', /Privacy/],
    ['T-1009', /refund-abuse/],
  ])('%s: escalates per policy', async (id, reason) => {
    const result = await runTriage(getTicket(id)!);
    expect(result.escalate).toBe(true);
    expect(result.escalationReasons.join('\n')).toMatch(reason);
  });

  it.each([['T-1011'], ['T-1012'], ['T-1014']])('%s: routine ticket is not escalated', async (id) => {
    const result = await runTriage(getTicket(id)!);
    expect(result.escalate).toBe(false);
  });

  it('records a trace with retrieval scores and raw model output', async () => {
    await runTriage(getTicket('T-1002')!);
    const trace = db.triageTraces.get('T-1002')!;
    expect(trace.retrieved[0]).toMatchObject({ docId: 'policy-refund-v3', status: 'active' });
    expect(trace.retrieved[0].score).toBeGreaterThan(0);
    expect(trace.rawResponse).toContain('"reply"');
  });
});

// Defense in depth: even if a future prompt change or a different model
// misbehaves, the server-side guards must still hold.
describe('output guards with a misbehaving model', () => {
  const evil = (payload: object): LLMClient => ({
    complete: async (_req: CompletionRequest) => JSON.stringify(payload),
  });

  beforeEach(() => db.triageResults.clear());

  it('replaces a reply that leaks internal notes', async () => {
    setLLMClient(
      evil({
        category: 'refund',
        urgency: 'medium',
        escalate: false,
        reply: 'Sure! FYI you have a Refund-abuse flag: 4 refunds in the last 12 months.',
      })
    );
    const result = await runTriage(getTicket('T-1009')!);
    expect(result.reply).toBe(SAFE_FALLBACK_REPLY);
    expect(result.warnings.join()).toMatch(/internal-only/);
  });

  it('blocks refund approval outside the window and escalates', async () => {
    setLLMClient(
      evil({
        category: 'refund',
        urgency: 'low',
        escalate: false,
        reply: 'Good news! Your refund has been approved.',
      })
    );
    const result = await runTriage(getTicket('T-1008')!);
    expect(result.reply).toBe(SAFE_FALLBACK_REPLY);
    expect(result.escalate).toBe(true);
    expect(result.warnings.join()).toMatch(/199 days ago/);
  });

  it.each([
    "I've issued a full refund to your card.",
    'Your refund has been processed.',
    "We'll refund you right away.",
    "I've gone ahead and refunded your purchase.",
    'The refund is on its way!',
    'Sure thing, the money will be back in your account shortly.',
  ])('paraphrased approval is blocked for an ineligible refund: %s', async (reply) => {
    setLLMClient(evil({ category: 'refund', urgency: 'low', escalate: false, reply }));
    const result = await runTriage(getTicket('T-1002')!);
    expect(result.reply).toBe(SAFE_FALLBACK_REPLY);
    expect(result.escalate).toBe(true);
  });

  it('refund request with no purchase record cannot be approved', async () => {
    setLLMClient(evil({ category: 'refund', urgency: 'low', escalate: false, reply: 'Refund started!' }));
    const t = { ...getTicket('T-1001')!, id: 'T-X', purchaseDate: undefined };
    const result = await runTriage(t);
    expect(result.reply).toBe(SAFE_FALLBACK_REPLY);
    expect(result.warnings.join()).toMatch(/no valid purchase record/);
  });

  it('a failed re-run keeps the previous result and trace', async () => {
    setLLMClient(evil({ category: 'general', urgency: 'low', escalate: false, reply: 'Thanks!' }));
    const t = getTicket('T-1012')!;
    const good = await runTriage(t);
    const goodTrace = db.triageTraces.get(t.id);
    setLLMClient({ complete: async () => 'I cannot help with that.' });
    await expect(runTriage(t)).rejects.toThrow();
    expect(db.triageResults.get(t.id)).toBe(good);
    expect(db.triageTraces.get(t.id)).toBe(goodTrace);
    // and the in-flight entry was cleared, so a retry runs
    setLLMClient(evil({ category: 'general', urgency: 'low', escalate: false, reply: 'Hello again' }));
    expect((await runTriage(t)).reply).toBe('Hello again');
  });

  it('model cannot lower escalation for a security incident', async () => {
    setLLMClient(evil({ category: 'general', urgency: 'low', escalate: 'false', reply: 'No worries!' }));
    const result = await runTriage(getTicket('T-1004')!);
    expect(result.escalate).toBe(true);
  });

  it('collapses concurrent triage requests for one ticket into one model call', async () => {
    let calls = 0;
    setLLMClient({
      complete: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return JSON.stringify({ category: 'general', urgency: 'low', escalate: false, reply: 'Thanks!' });
      },
    });
    const t = getTicket('T-1012')!;
    const [a, b] = await Promise.all([runTriage(t), runTriage(t)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});
