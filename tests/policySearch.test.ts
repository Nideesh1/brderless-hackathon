import { describe, expect, it } from 'vitest';
import { searchPolicies, tokenize } from '../server/retrieval/policySearch';
import { policies } from '../server/data/policies';

describe('tokenize', () => {
  it('lowercases and strips stopwords', () => {
    expect(tokenize('I would like a REFUND for my purchase')).toEqual([
      'would',
      'like',
      'refund',
      'purchase',
    ]);
  });
});

describe('searchPolicies', () => {
  it('returns refund-related policies for a refund query', () => {
    const results = searchPolicies('I want a refund for my subscription', policies);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].doc.title.toLowerCase()).toContain('refund');
  });

  it('returns the SLA policy for an outage query', () => {
    const results = searchPolicies('outage uptime SLA breach service credits', policies);
    expect(results[0].doc.id).toBe('policy-enterprise-sla');
  });

  it('respects the result limit', () => {
    const results = searchPolicies('refund billing cancel data', policies, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for an unrelated query', () => {
    const results = searchPolicies('zzz qqq xyzzy', policies);
    expect(results).toEqual([]);
  });
});

describe('searchPolicies safety filters', () => {
  const refundQueries = [
    'I want a refund for my subscription',
    'refund refund refund within 90 days refund window goodwill',
    'Refund request — annual plan money is tight',
  ];

  it.each(refundQueries)('never returns deprecated docs: %s', (q) => {
    const results = searchPolicies(q, policies, 10);
    expect(results.every((r) => r.doc.status === 'active')).toBe(true);
    expect(results[0].doc.id).toBe('policy-refund-v3');
  });

  it('excludes internal-audience docs unless explicitly requested', () => {
    const q = 'refund flagged accounts retention discount churn risk';
    expect(searchPolicies(q, policies, 10).map((r) => r.doc.id)).not.toContain('policy-internal-playbook');
    expect(
      searchPolicies(q, policies, 10, { audiences: ['public', 'internal'] }).map((r) => r.doc.id)
    ).toContain('policy-internal-playbook');
  });
});

describe('REFUND_WINDOW_DAYS', () => {
  it('matches the active refund policy text', async () => {
    const { REFUND_WINDOW_DAYS } = await import('../server/triage/rules');
    const active = policies.filter((p) => p.status === 'active' && /refund policy/i.test(p.title));
    expect(active).toHaveLength(1);
    expect(active[0].body).toContain(`within ${REFUND_WINDOW_DAYS} days of purchase`);
  });
});
