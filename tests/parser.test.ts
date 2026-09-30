import { describe, expect, it } from 'vitest';
import { parseTriageResponse } from '../server/triage/parser';

const validPayload = {
  category: 'billing',
  urgency: 'medium',
  escalate: false,
  reply: 'Hi, thanks for reaching out.',
  reasoning: 'Standard billing question.',
};

describe('parseTriageResponse', () => {
  it('parses a bare JSON response', () => {
    const result = parseTriageResponse(JSON.stringify(validPayload));
    expect(result.category).toBe('billing');
    expect(result.escalate).toBe(false);
  });

  it('parses JSON wrapped in a markdown code fence', () => {
    const raw = '```json\n' + JSON.stringify(validPayload) + '\n```';
    const result = parseTriageResponse(raw);
    expect(result.reply).toContain('thanks for reaching out');
  });

  it('parses JSON surrounded by prose', () => {
    const raw = `Sure! Here is the triage:\n${JSON.stringify(validPayload)}\nHope that helps.`;
    const result = parseTriageResponse(raw);
    expect(result.urgency).toBe('medium');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseTriageResponse('I could not triage this ticket.')).toThrow(
      /No JSON object/
    );
  });

  it('throws when a required field is missing', () => {
    const { reply, ...withoutReply } = validPayload;
    expect(() => parseTriageResponse(JSON.stringify(withoutReply))).toThrow(
      /missing field: reply/
    );
  });
});

describe('parseTriageResponse normalization', () => {
  const parse = (over: object) => parseTriageResponse(JSON.stringify({ ...validPayload, ...over }));

  it.each([
    ['Refund', 'refund'],
    ['refund_request', 'refund'],
    ['Billing', 'billing'],
    ['billing_issue', 'billing'],
    ['incident', 'outage'],
    ['churn', 'cancellation'],
    ['data_request', 'privacy'],
    ['Security', 'security'],
    ['other', 'general'],
    ['something-new', 'general'],
  ])('category %s -> %s', (raw, expected) => {
    expect(parse({ category: raw }).category).toBe(expected);
  });

  it.each([
    ['High', 'high'],
    ['urgent', 'high'],
    ['Medium', 'medium'],
    ['normal', 'medium'],
    ['Low', 'low'],
    ['LOW ', 'low'],
    ['whenever', 'medium'],
  ])('urgency %s -> %s', (raw, expected) => {
    expect(parse({ urgency: raw }).urgency).toBe(expected);
  });

  it('records what it had to repair', () => {
    expect(parse({ urgency: 'urgent' }).normalizationNotes).toEqual(['urgency "urgent" -> high']);
  });

  it('parses string booleans strictly ("false" is not true)', () => {
    expect(parse({ escalate: 'false' }).escalate).toBe(false);
    expect(parse({ escalate: 'true' }).escalate).toBe(true);
    expect(() => parse({ escalate: 'maybe' })).toThrow(/non-boolean escalate/);
  });

  it('accepts 1/0 for escalate and rejects non-string replies', () => {
    expect(parse({ escalate: 1 }).escalate).toBe(true);
    expect(parse({ escalate: 0 }).escalate).toBe(false);
    expect(() => parse({ reply: { text: 'hi' } })).toThrow(/not a string/);
  });

  it('rejects an empty reply', () => {
    expect(() => parse({ reply: '   ' })).toThrow(/empty reply/);
  });
});
