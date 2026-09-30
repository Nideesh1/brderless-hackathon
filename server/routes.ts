import { Router } from 'express';
import type { TicketSummary } from '../shared/types';
import { db, getTicket } from './store';
import { runTriage } from './triage/triageService';

export const api = Router();

api.get('/tickets', (_req, res) => {
  const summaries: TicketSummary[] = db.tickets.map((t) => {
    const triage = db.triageResults.get(t.id);
    return {
      id: t.id,
      subject: t.subject,
      customerName: t.customer.name,
      plan: t.customer.plan,
      status: t.status,
      createdAt: t.createdAt,
      lastTriage: triage
        ? {
            category: triage.category,
            urgency: triage.urgency,
            escalate: triage.escalate,
          }
        : undefined,
    };
  });
  res.json(summaries);
});

api.get('/tickets/:id', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

api.get('/tickets/:id/triage', (req, res) => {
  const result = db.triageResults.get(req.params.id);
  if (!result) return res.status(404).json({ error: 'No triage result yet' });
  res.json(result);
});

// Internal debugging: full provenance of the last triage (prompt, retrieval
// scores, raw model output, guard decisions). Contains internal notes' effects
// and customer PII — must sit behind agent auth in production.
const traceEnabled =
  process.env.ENABLE_TRIAGE_TRACE === 'true' ||
  (process.env.ENABLE_TRIAGE_TRACE !== 'false' && process.env.NODE_ENV !== 'production');

api.get('/tickets/:id/triage/trace', (req, res) => {
  if (!traceEnabled) return res.status(404).json({ error: 'Not found' });
  const trace = db.triageTraces.get(req.params.id);
  if (!trace) return res.status(404).json({ error: 'No triage trace yet' });
  res.json(trace);
});

api.post('/tickets/:id/triage', async (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  try {
    const result = await runTriage(ticket);
    res.json(result);
  } catch (err) {
    // Details (possibly provider error bodies) go to the server log / trace,
    // not to the browser.
    console.error(`[triage] ${ticket.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'AI triage failed. Please retry.' });
  }
});

api.get('/policies', (_req, res) => {
  res.json(db.policies.map(({ id, title, status, audience, updatedAt }) => ({
    id, title, status, audience, updatedAt,
  })));
});
