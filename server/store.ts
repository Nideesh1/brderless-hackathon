import type { Ticket, TriageResult } from '../shared/types';
import type { TriageTrace } from './triage/triageService';
import { tickets as seedTickets } from './data/tickets';
import { policies as seedPolicies } from './data/policies';

// Simple in-memory store seeded at startup. Restarting the server resets state.
export const db = {
  tickets: [...seedTickets] as Ticket[],
  policies: [...seedPolicies],
  triageResults: new Map<string, TriageResult>(),
  // Full provenance of the last triage per ticket (prompt, retrieval scores,
  // raw model output, guard decisions). Internal/debug use only.
  triageTraces: new Map<string, TriageTrace>(),
};

export function getTicket(id: string): Ticket | undefined {
  return db.tickets.find((t) => t.id === id);
}
