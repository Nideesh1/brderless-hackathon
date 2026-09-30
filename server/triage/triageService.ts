import type { Ticket, TriageResult } from '../../shared/types';
import { db } from '../store';
import { searchPolicies } from '../retrieval/policySearch';
import { buildTriagePrompt, SYSTEM_PROMPT } from './promptBuilder';
import { parseTriageResponse } from './parser';
import { getLLMClient } from '../llm/client';
import {
  isSafeBlockedRefundReply,
  escalationRuleReasons,
  findInternalLeaks,
  refundApprovalBlocker,
  SAFE_FALLBACK_REPLY,
  urgencyFloor,
} from './rules';

/** Everything needed to explain a triage result after the fact. */
export interface TriageTrace {
  ticketId: string;
  startedAt: string;
  latencyMs: number;
  query: string;
  retrieved: { docId: string; title: string; status: string; audience: string; score: number }[];
  system: string;
  prompt: string;
  rawResponse: string;
  parsed: unknown;
  normalizationNotes: string[];
  llmEscalate: boolean;
  ruleEscalationReasons: string[];
  guardActions: string[];
  error?: string;
}

// Collapse concurrent triage requests for the same ticket into one LLM call
// (double-clicks, React StrictMode double effects, two agents on one ticket).
// Keyed by ticket id only: fine while tickets and policies are immutable; key
// by ticket/policy version once they can change. Per-process only.
const inFlight = new Map<string, Promise<TriageResult>>();

export function runTriage(ticket: Ticket): Promise<TriageResult> {
  const existing = inFlight.get(ticket.id);
  if (existing) return existing;
  const p = doTriage(ticket).finally(() => inFlight.delete(ticket.id));
  inFlight.set(ticket.id, p);
  return p;
}

async function doTriage(ticket: Ticket): Promise<TriageResult> {
  const started = Date.now();
  const query = `${ticket.subject} ${ticket.message}`;
  const retrieved = searchPolicies(query, db.policies, 3);
  const prompt = buildTriagePrompt(
    ticket,
    retrieved.map((r) => r.doc)
  );

  const trace: TriageTrace = {
    ticketId: ticket.id,
    startedAt: new Date(started).toISOString(),
    latencyMs: 0,
    query,
    retrieved: retrieved.map((r) => ({
      docId: r.doc.id,
      title: r.doc.title,
      status: r.doc.status,
      audience: r.doc.audience,
      score: r.score,
    })),
    system: SYSTEM_PROMPT,
    prompt,
    rawResponse: '',
    parsed: null,
    normalizationNotes: [],
    llmEscalate: false,
    ruleEscalationReasons: [],
    guardActions: [],
  };

  try {
    const llm = getLLMClient();
    trace.rawResponse = await llm.complete({ system: SYSTEM_PROMPT, user: prompt });
    const parsed = parseTriageResponse(trace.rawResponse);
    trace.parsed = parsed;
    trace.normalizationNotes = parsed.normalizationNotes;
    trace.llmEscalate = parsed.escalate;

    // Escalation: rules set a floor the model can raise but never lower.
    const ruleReasons = escalationRuleReasons(ticket);
    trace.ruleEscalationReasons = ruleReasons;
    const escalationReasons = [...ruleReasons];
    if (parsed.escalate) escalationReasons.unshift('Model recommended escalation');

    // Output guards on the customer-facing reply.
    const warnings: string[] = [];
    let reply = parsed.reply;

    const leaks = findInternalLeaks(reply, ticket);
    if (leaks.length) {
      reply = SAFE_FALLBACK_REPLY;
      warnings.push(`Drafted reply contained internal-only information and was replaced (${leaks.join('; ')})`);
      trace.guardActions.push(`internal-leak: ${leaks.join('; ')}`);
    }

    const blocker = refundApprovalBlocker(ticket);
    if (blocker && reply !== SAFE_FALLBACK_REPLY && !isSafeBlockedRefundReply(reply)) {
      reply = SAFE_FALLBACK_REPLY;
      warnings.push(
        `Drafted reply did not clearly decline the refund, but ${blocker}. Reply replaced; a human must decide.`
      );
      if (!escalationReasons.some((r) => r.startsWith('Guard:'))) {
        escalationReasons.push('Guard: model tried to approve a refund that needs human sign-off');
      }
      trace.guardActions.push(`blocked refund approval: ${blocker}`);
    }

    const result: TriageResult = {
      ticketId: ticket.id,
      category: parsed.category,
      urgency: urgencyFloor(ticket) ?? parsed.urgency,
      escalate: escalationReasons.length > 0,
      escalationReasons,
      reply,
      reasoning: parsed.reasoning,
      citations: retrieved.map((r) => ({
        docId: r.doc.id,
        title: r.doc.title,
        snippet: r.doc.body.slice(0, 140) + '…',
      })),
      warnings,
      generatedAt: new Date().toISOString(),
    };

    db.triageResults.set(ticket.id, result);
    return result;
  } catch (err) {
    trace.error = (err as Error).message;
    throw err;
  } finally {
    trace.latencyMs = Date.now() - started;
    // The stored trace must explain the result currently shown, so a failed
    // re-run only goes to the log and does not replace the last good trace.
    if (!trace.error) db.triageTraces.set(ticket.id, trace);
    logTrace(trace);
  }
}

// One structured line per triage; the full prompt/raw output stay in the
// trace store (GET /api/tickets/:id/triage/trace) to keep logs small and
// avoid writing customer PII to log aggregation by default.
function logTrace(t: TriageTrace): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  console.log(
    JSON.stringify({
      event: 'triage',
      ticketId: t.ticketId,
      latencyMs: t.latencyMs,
      retrieved: t.retrieved.map((r) => `${r.docId}:${r.score}`),
      normalization: t.normalizationNotes,
      llmEscalate: t.llmEscalate,
      ruleEscalations: t.ruleEscalationReasons.length,
      guardActions: t.guardActions,
      error: t.error,
    })
  );
}
