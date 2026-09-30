import { describe, expect, it } from 'vitest';
import { calendarDaysBetween, escalationRuleReasons, refundEligibility } from '../server/triage/rules';
import { tickets } from '../server/data/tickets';

describe('calendarDaysBetween', () => {
  it('runs in a DST timezone (npm test pins TZ) so seed dates really cross DST', () => {
    expect(process.env.TZ).toBe('America/New_York');
  });

  it('is not shortened by a DST shift in the range', () => {
    // 23 hours of elapsed time across the US spring-forward still spans 2 calendar days
    expect(calendarDaysBetween('2026-03-07T12:00:00Z', '2026-03-09T11:00:00Z')).toBe(2);
    expect(calendarDaysBetween('2025-12-25T10:00:00Z', '2026-07-12T09:00:00Z')).toBe(199);
  });
});

describe('refundEligibility', () => {
  const base = tickets[0];
  const at = (purchase: string, created: string) =>
    refundEligibility({ ...base, purchaseDate: purchase, createdAt: created })!;

  it('day 30 is inside the window, day 31 is outside', () => {
    expect(at('2026-06-01T23:00:00Z', '2026-07-01T01:00:00Z').eligible).toBe(true);
    expect(at('2026-06-01T01:00:00Z', '2026-07-02T23:00:00Z').eligible).toBe(false);
  });

  it('returns null when there is no purchase date', () => {
    expect(refundEligibility({ ...base, purchaseDate: undefined })).toBeNull();
  });
});

describe('escalationRuleReasons', () => {
  const t = (over: Partial<(typeof tickets)[0]>) => ({ ...tickets[0], internalNotes: [], ...over });

  it('calmly-worded unauthorized access still escalates', () => {
    expect(
      escalationRuleReasons(t({ subject: 'hi', message: 'Someone signed in to my account from Lagos, it wasn\'t me. No rush!' }))
    ).toHaveLength(1);
  });

  it('GDPR requests escalate to privacy', () => {
    expect(escalationRuleReasons(t({ subject: 'x', message: 'Under GDPR send me my personal data' }))[0]).toMatch(/privacy/);
  });

  it('SLA rule applies to enterprise plans only', () => {
    const msg = { subject: 'Dashboard down', message: 'outage since 6am' };
    expect(escalationRuleReasons(t({ ...msg, customer: { ...tickets[0].customer, plan: 'enterprise' } }))).toHaveLength(1);
    expect(escalationRuleReasons(t({ ...msg, customer: { ...tickets[0].customer, plan: 'pro' } }))).toHaveLength(0);
  });

  it.each([
    'Someone logged into my account from Russia',
    'Somebody accessed my account without permission',
    'My password was changed and I did not do it',
  ])('security phrasing escalates: %s', (message) => {
    expect(escalationRuleReasons(t({ subject: 'help', message }))[0]).toMatch(/Security/);
  });

  it('delete-my-data requests escalate to privacy', () => {
    expect(escalationRuleReasons(t({ subject: 'x', message: 'Please delete my account and all my data' }))[0]).toMatch(/privacy/);
  });

  it('an unauthorized card charge is billing, not a security incident', () => {
    expect(escalationRuleReasons(t({ subject: 'x', message: 'There is an unauthorized charge on my card' }))).toEqual([]);
  });

  it('serial-refunder note wording also counts as a flag', () => {
    expect(
      escalationRuleReasons(t({ subject: 'refund please', message: 'refund', internalNotes: ['Serial refunder: 4 this year'] }))
    ).toHaveLength(1);
  });

  it('plain password reset is not a security incident', () => {
    expect(escalationRuleReasons(tickets.find((x) => x.id === 'T-1013')!)).toEqual([]);
  });
});
