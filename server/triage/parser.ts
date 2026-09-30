import { CATEGORIES, URGENCIES, type Category, type Urgency } from '../../shared/types';

export interface ParsedTriage {
  category: Category;
  urgency: Urgency;
  escalate: boolean;
  reply: string;
  reasoning: string;
  /** Labels we had to repair; surfaced in logs so vocabulary drift is visible. */
  normalizationNotes: string[];
}

// Synonyms real models produce for each canonical label. Keys are compared
// after lowercasing and collapsing separators, so "Refund Request",
// "refund_request" and "refund-request" all hit "refund request".
const CATEGORY_SYNONYMS: Record<string, Category> = {
  'refund request': 'refund',
  refunds: 'refund',
  'billing issue': 'billing',
  invoice: 'billing',
  invoicing: 'billing',
  payment: 'billing',
  incident: 'outage',
  downtime: 'outage',
  'service outage': 'outage',
  'sla breach': 'outage',
  'security incident': 'security',
  'account security': 'security',
  churn: 'cancellation',
  cancel: 'cancellation',
  'data request': 'privacy',
  gdpr: 'privacy',
  'data export': 'privacy',
  'account management': 'account',
  api: 'account',
  other: 'general',
  feedback: 'general',
};

const URGENCY_SYNONYMS: Record<string, Urgency> = {
  normal: 'medium',
  moderate: 'medium',
  med: 'medium',
  urgent: 'high',
  critical: 'high',
  p1: 'high',
  p2: 'medium',
  p3: 'low',
  minor: 'low',
};

function key(label: unknown): string {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

export function normalizeCategory(label: unknown): Category | null {
  const k = key(label);
  if ((CATEGORIES as readonly string[]).includes(k)) return k as Category;
  return CATEGORY_SYNONYMS[k] ?? null;
}

export function normalizeUrgency(label: unknown): Urgency | null {
  const k = key(label);
  if ((URGENCIES as readonly string[]).includes(k)) return k as Urgency;
  return URGENCY_SYNONYMS[k] ?? null;
}

/** Strict boolean parse: `Boolean("false")` is true, which silently flips escalation. */
export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  const k = key(value);
  if (k === 'true' || k === 'yes') return true;
  if (k === 'false' || k === 'no') return false;
  return null;
}

/**
 * Extract the triage JSON from a model response. Models sometimes wrap JSON
 * in code fences or prose, so we locate the outermost object first. Everything
 * is then validated into the canonical vocabulary — treat model output like
 * any other untrusted external input.
 */
export function parseTriageResponse(raw: string): ParsedTriage {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));

  for (const field of ['category', 'urgency', 'escalate', 'reply']) {
    if (!(field in parsed)) {
      throw new Error(`Model response missing field: ${field}`);
    }
  }

  const normalizationNotes: string[] = [];

  let category = normalizeCategory(parsed.category);
  if (!category) {
    normalizationNotes.push(`unknown category "${parsed.category}" -> general`);
    category = 'general';
  } else if (category !== parsed.category) {
    normalizationNotes.push(`category "${parsed.category}" -> ${category}`);
  }

  // Unknown urgency defaults to medium rather than low: under-prioritising a
  // ticket is the more expensive mistake.
  let urgency = normalizeUrgency(parsed.urgency);
  if (!urgency) {
    normalizationNotes.push(`unknown urgency "${parsed.urgency}" -> medium`);
    urgency = 'medium';
  } else if (urgency !== parsed.urgency) {
    normalizationNotes.push(`urgency "${parsed.urgency}" -> ${urgency}`);
  }

  const escalate = parseBoolean(parsed.escalate);
  if (escalate === null) {
    throw new Error(`Model response has non-boolean escalate: ${JSON.stringify(parsed.escalate)}`);
  }

  if (typeof parsed.reply !== 'string') throw new Error('Model response reply is not a string');
  const reply = parsed.reply.trim();
  if (!reply) throw new Error('Model response has an empty reply');

  return {
    category,
    urgency,
    escalate,
    reply,
    reasoning: String(parsed.reasoning ?? ''),
    normalizationNotes,
  };
}
