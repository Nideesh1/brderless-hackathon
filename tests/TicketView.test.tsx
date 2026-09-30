// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket, TriageResult } from '../shared/types';
import { tickets } from '../server/data/tickets';

// Controllable API: each call returns a promise the test resolves by hand, so
// we can make ticket A's triage arrive *after* the user switched to ticket B.
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const pending = {
  generate: new Map<string, Deferred<TriageResult>>(),
  fetch: new Map<string, Deferred<TriageResult>>(),
};

vi.mock('../src/api', () => ({
  fetchTicket: (id: string) => Promise.resolve(tickets.find((t) => t.id === id) as Ticket),
  fetchTriage: (id: string) => {
    const d = deferred<TriageResult>();
    pending.fetch.set(id, d);
    return d.promise;
  },
  generateTriage: (id: string) => {
    const d = deferred<TriageResult>();
    pending.generate.set(id, d);
    return d.promise;
  },
}));

const { TicketView } = await import('../src/components/TicketView');

const triageFor = (id: string, reply: string): TriageResult => ({
  ticketId: id,
  category: 'general',
  urgency: 'low',
  escalate: false,
  escalationReasons: [],
  reply,
  reasoning: '',
  citations: [],
  warnings: [],
  generatedAt: new Date().toISOString(),
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('TicketView ticket switching', () => {
  beforeEach(() => {
    pending.generate.clear();
    pending.fetch.clear();
  });

  // No stored triage yet: the GET 404s and the view generates one.
  const noStored = async (id: string) => {
    await act(async () => pending.fetch.get(id)!.reject(new Error('No triage result yet')));
    await flush();
  };
  afterEach(cleanup);

  it('never shows the previous ticket\'s triage after switching', async () => {
    const { rerender } = render(<TicketView ticketId="T-1003" onTriageComplete={() => {}} />);
    await flush();
    await noStored('T-1003');
    rerender(<TicketView ticketId="T-1012" onTriageComplete={() => {}} />);
    await flush();
    await noStored('T-1012');

    // A's slow response lands after the switch.
    await act(async () => pending.generate.get('T-1003')!.resolve(triageFor('T-1003', 'REPLY FOR 1003')));
    await flush();
    expect(screen.queryByText('REPLY FOR 1003')).toBeNull();
    expect(screen.getByText(/Running AI triage/)).toBeTruthy();

    await act(async () => pending.generate.get('T-1012')!.resolve(triageFor('T-1012', 'REPLY FOR 1012')));
    await flush();
    expect(screen.getByText('REPLY FOR 1012')).toBeTruthy();
  });

  it('clears the old triage immediately when switching', async () => {
    const { rerender } = render(<TicketView ticketId="T-1003" onTriageComplete={() => {}} />);
    await flush();
    await noStored('T-1003');
    await act(async () => pending.generate.get('T-1003')!.resolve(triageFor('T-1003', 'REPLY FOR 1003')));
    await flush();
    expect(screen.getByText('REPLY FOR 1003')).toBeTruthy();

    rerender(<TicketView ticketId="T-1012" onTriageComplete={() => {}} />);
    await flush();
    expect(screen.queryByText('REPLY FOR 1003')).toBeNull();
  });

  it("a Regenerate result for the previous ticket is dropped after switching", async () => {
    const { rerender } = render(<TicketView ticketId="T-1003" onTriageComplete={() => {}} />);
    await flush();
    await act(async () => pending.fetch.get('T-1003')!.resolve(triageFor('T-1003', 'STORED 1003')));
    await flush();
    await act(async () => screen.getByRole('button', { name: 'Regenerate AI Triage' }).click());
    await flush();
    const regen1003 = pending.generate.get('T-1003')!;

    rerender(<TicketView ticketId="T-1012" onTriageComplete={() => {}} />);
    await flush();
    await act(async () => regen1003.resolve(triageFor('T-1003', 'REGENERATED 1003')));
    await flush();
    expect(screen.queryByText('REGENERATED 1003')).toBeNull();
    expect(screen.queryByText('STORED 1003')).toBeNull();

    await act(async () => pending.fetch.get('T-1012')!.resolve(triageFor('T-1012', 'STORED 1012')));
    await flush();
    expect(screen.getByText('STORED 1012')).toBeTruthy();
  });
});
