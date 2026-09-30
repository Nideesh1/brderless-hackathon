export interface Customer {
  name: string;
  email: string;
  plan: 'free' | 'pro' | 'enterprise';
  accountId: string;
  monthlySpendUsd: number;
}

export interface Ticket {
  id: string;
  subject: string;
  message: string;
  customer: Customer;
  createdAt: string;
  purchaseDate?: string;
  status: 'open' | 'pending' | 'closed';
  internalNotes: string[];
}

export interface PolicyDoc {
  id: string;
  title: string;
  body: string;
  status: 'active' | 'deprecated';
  audience: 'public' | 'internal';
  updatedAt: string;
}

export interface Citation {
  docId: string;
  title: string;
  snippet: string;
}

// Canonical label vocabularies. LLM output is normalized into these at the
// parser boundary; nothing downstream should ever see a raw model label.
export const CATEGORIES = [
  'refund',
  'billing',
  'outage',
  'security',
  'cancellation',
  'privacy',
  'account',
  'general',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ['low', 'medium', 'high'] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface TriageResult {
  ticketId: string;
  category: Category;
  urgency: Urgency;
  escalate: boolean;
  /** Why the ticket is escalated: the model's call and/or deterministic policy rules. */
  escalationReasons: string[];
  reply: string;
  reasoning: string;
  citations: Citation[];
  /** Guardrail interventions the agent should know about before sending the reply. */
  warnings: string[];
  generatedAt: string;
}

export interface TicketSummary {
  id: string;
  subject: string;
  customerName: string;
  plan: Customer['plan'];
  status: Ticket['status'];
  createdAt: string;
  lastTriage?: {
    category: Category;
    urgency: Urgency;
    escalate: boolean;
  };
}
