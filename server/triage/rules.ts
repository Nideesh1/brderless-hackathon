import type { Ticket } from '../../shared/types';

/**
 * Deterministic business rules applied around the LLM.
 *
 * The model is good at reading tone and drafting text; it is not an acceptable
 * sole decision-maker for compliance-bound actions. Rules here can only make
 * the outcome safer: they may raise escalation or block a risky reply, never
 * lower escalation.
 */

/** Must match the active refund policy (policy-refund-v3); a test pins the two together. */
export const REFUND_WINDOW_DAYS = 30;

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Whole calendar days between two instants, compared as UTC dates. Flooring
 * raw elapsed milliseconds loses a day whenever a DST shift falls in the
 * range, which moves the refund-window boundary depending on server timezone.
 */
export function calendarDaysBetween(from: string, to: string): number {
  const utcDay = (iso: string) => {
    const d = new Date(iso);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

export interface RefundEligibility {
  eligible: boolean;
  daysSincePurchase: number;
  windowDays: number;
}

export function refundEligibility(ticket: Ticket): RefundEligibility | null {
  if (!ticket.purchaseDate) return null;
  const daysSincePurchase = calendarDaysBetween(ticket.purchaseDate, ticket.createdAt);
  return {
    eligible: daysSincePurchase <= REFUND_WINDOW_DAYS,
    daysSincePurchase,
    windowDays: REFUND_WINDOW_DAYS,
  };
}

export function mentionsRefund(ticket: Ticket): boolean {
  return /refund|money back/i.test(`${ticket.subject}\n${ticket.message}`);
}

export function hasRefundAbuseFlag(ticket: Ticket): boolean {
  return ticket.internalNotes.some((n) => REFUND_ABUSE_NOTE.test(n));
}

/**
 * Why the reply must not promise a refund, or null if it may. A promise the
 * agent then has to walk back is worse than a holding reply.
 */
export function refundApprovalBlocker(ticket: Ticket): string | null {
  const refund = refundEligibility(ticket);
  if (mentionsRefund(ticket) && (!refund || !Number.isFinite(refund.daysSincePurchase))) {
    return 'there is no valid purchase record to check the refund window against';
  }
  if (refund && !refund.eligible) {
    return `the purchase was ${refund.daysSincePurchase} days ago (policy window ${refund.windowDays} days)`;
  }
  if (hasRefundAbuseFlag(ticket)) {
    return 'the account is flagged for human review of refunds';
  }
  return null;
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// Signals are matched against the ticket itself (trusted structure + the
// customer's own words), not against the model's category label, so a model
// mislabelling a ticket cannot suppress a mandatory escalation.
const SECURITY_SIGNALS = [
  /unauthori[sz]ed (access|log-?in|sign[- ]?in|use of my account|user)/i,
  /(signed|logged) ?in(to)? (to )?my account/i,
  /log-?in (from|attempt|notification)/i,
  /accessed my account/i,
  /password (was )?changed/i,
  /sign[- ]?in (from|attempt|notification)/i,
  /(wasn'?t|was not) me/i,
  /compromis/i,
  /hacked/i,
  /suspicious (login|log-in|sign[- ]?in|activity)/i,
  /account takeover/i,
];

const PRIVACY_SIGNALS = [
  /\bgdpr\b/i,
  /\bccpa\b/i,
  /personal data/i,
  /data (export|deletion|access) request/i,
  /(export|delete|erase) (of )?(all )?(my )?(personal )?data/i,
  /right to (be forgotten|erasure|access)/i,
  /delete my account and (all )?(of )?my data/i,
  /all (of )?(the )?(my )?(personal )?data (you|your company) (hold|have|store)/i,
];

const OUTAGE_SIGNALS = [/outage/i, /\bdown for\b/i, /\bdown since\b/i, /\bsla\b/i, /uptime/i, /degraded/i];

// Free-text match on agent notes. A structured account flag would be better;
// until one exists, match the phrasings the playbook uses.
const REFUND_ABUSE_NOTE = /refund[- ]abuse|serial refunder/i;

/** Rule hits that also set an urgency floor (policy response times are minutes/hours). */
export function urgencyFloor(ticket: Ticket): 'high' | null {
  const text = `${ticket.subject}\n${ticket.message}`;
  if (matches(text, SECURITY_SIGNALS)) return 'high';
  if (ticket.customer.plan === 'enterprise' && matches(text, OUTAGE_SIGNALS)) return 'high';
  return null;
}

export function escalationRuleReasons(ticket: Ticket): string[] {
  const text = `${ticket.subject}\n${ticket.message}`;
  const reasons: string[] = [];

  if (matches(text, SECURITY_SIGNALS)) {
    reasons.push('Security Incident Response Policy: potential unauthorized access must go to the security team within 30 minutes, regardless of perceived severity');
  }
  if (matches(text, PRIVACY_SIGNALS)) {
    reasons.push('Data Export & Privacy Policy: data export/deletion requests must be routed to the privacy team');
  }
  if (ticket.customer.plan === 'enterprise' && matches(text, OUTAGE_SIGNALS)) {
    reasons.push('Enterprise SLA Policy: suspected SLA breaches must be escalated to the enterprise success team immediately');
  }
  if (mentionsRefund(ticket) && hasRefundAbuseFlag(ticket)) {
    reasons.push('Internal playbook: account carries a refund-abuse flag; a human must review this refund request');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Output guards — checks on the drafted reply before it reaches an agent.

const REFUND_APPROVAL_PATTERNS = [
  /refund (has been|is|was) (approved|processed|issued|initiated)/i,
  /approved your refund/i,
  /started the refund/i,
  /(processed|issued|initiated) (a |your |the )?(full |partial )?refund/i,
  /refund(ed)? (you|your purchase|your order)/i,
  /refund is on (its|it's) way/i,
  /within our \d+-day refund window/i,
];

export function claimsRefundApproval(reply: string): boolean {
  return matches(reply, REFUND_APPROVAL_PATTERNS);
}

// A blocked refund reply must positively say no / not yet. Checking only for
// approval phrasing is a denylist that any paraphrase slips past; this fails closed.
const REFUND_DENIAL_OR_HOLD_PATTERNS = [
  /unable to (process|issue|offer) (a|the|your)? ?refund/i,
  /(not|isn'?t) eligible for a refund/i,
  /outside (of )?our \d+-day refund window/i,
  /cannot (process|issue|offer) (a|the|your)? ?refund/i,
];

export function isSafeBlockedRefundReply(reply: string): boolean {
  return !claimsRefundApproval(reply) && matches(reply, REFUND_DENIAL_OR_HOLD_PATTERNS);
}

// Patterns for internal-only data classes that must never appear in a
// customer reply even if paraphrased (the verbatim-note check misses those).
const INTERNAL_MARKERS = [
  /risk score/i,
  /refund[- ]abuse/i,
  /fraud (risk|score|flag)/i,
  /\bINC-\d+/,
  /internal (note|only|playbook)/i,
  /retention (discount|offer)/i,
  /churn risk/i,
];

/** Returns human-readable descriptions of any internal data found in the reply. */
export function findInternalLeaks(reply: string, ticket: Ticket): string[] {
  const leaks: string[] = [];
  const lowerReply = reply.toLowerCase();
  for (const note of ticket.internalNotes) {
    // Any run of 5+ consecutive words from a note counts as a leak.
    const words = note.toLowerCase().split(/\s+/).filter(Boolean);
    for (let i = 0; i + 5 <= words.length; i++) {
      if (lowerReply.includes(words.slice(i, i + 5).join(' '))) {
        leaks.push(`internal note text: "${note}"`);
        break;
      }
    }
    if (words.length < 5 && words.length > 0 && lowerReply.includes(note.toLowerCase())) {
      leaks.push(`internal note text: "${note}"`);
    }
  }
  for (const marker of INTERNAL_MARKERS) {
    const m = reply.match(marker);
    if (m) leaks.push(`internal-only term: "${m[0]}"`);
  }
  return leaks;
}

export const SAFE_FALLBACK_REPLY =
  'Hi, thanks for reaching out. We have received your request and a member of our team ' +
  'is reviewing it. We will follow up with you shortly.\n\nBest regards,\nSupport Team';
