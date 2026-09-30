import { useEffect, useRef, useState } from 'react';
import type { Ticket, TriageResult } from '../../shared/types';
import { fetchTicket, fetchTriage, generateTriage } from '../api';
import { TriagePanel } from './TriagePanel';

interface Props {
  ticketId: string;
  onTriageComplete: () => void;
}

export function TicketView({ ticketId, onTriageComplete }: Props) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);

  // Every triage request (initial load or Regenerate) takes a sequence
  // number; only the latest request may touch triage state. This drops
  // responses for a ticket the user has left, and stops an older request for
  // the same ticket from overwriting a newer one.
  const latestRequest = useRef(0);
  const onTriageCompleteRef = useRef(onTriageComplete);
  onTriageCompleteRef.current = onTriageComplete;

  const runTriageRequest = (forId: string, request: () => Promise<TriageResult>) => {
    const seq = ++latestRequest.current;
    const isLatest = () => latestRequest.current === seq;
    setTriageLoading(true);
    setTriageError(null);
    request()
      .then((result) => {
        if (isLatest() && result.ticketId === forId) setTriage(result);
      })
      .catch((e: Error) => isLatest() && setTriageError(e.message))
      .finally(() => isLatest() && setTriageLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    // Clear everything from the previous ticket so it can never be shown
    // (or acted on) under this ticket's header.
    setTicket(null);
    setTicketError(null);
    setTriage(null);

    fetchTicket(ticketId)
      .then((t) => !cancelled && setTicket(t))
      .catch((e: Error) => !cancelled && setTicketError(e.message));

    // Load the existing triage, or generate one on first view.
    runTriageRequest(ticketId, () =>
      fetchTriage(ticketId).catch(() =>
        generateTriage(ticketId).then((r) => {
          onTriageCompleteRef.current();
          return r;
        })
      )
    );

    return () => {
      cancelled = true;
      latestRequest.current++; // invalidate whatever is in flight for this ticket
    };
  }, [ticketId]);

  const regenerate = () =>
    runTriageRequest(ticketId, () =>
      generateTriage(ticketId).then((r) => {
        onTriageCompleteRef.current();
        return r;
      })
    );

  if (ticketError) return <div className="error-banner">{ticketError}</div>;
  if (!ticket) return <div className="empty-state">Loading ticket…</div>;

  return (
    <div className="ticket-view">
      <section className="ticket-details card">
        <div className="ticket-details-header">
          <h2>{ticket.subject}</h2>
          <span className="ticket-id">{ticket.id}</span>
        </div>
        <dl className="customer-meta">
          <div>
            <dt>Customer</dt>
            <dd>
              {ticket.customer.name} ({ticket.customer.email})
            </dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd className={`plan plan-${ticket.customer.plan}`}>{ticket.customer.plan}</dd>
          </div>
          <div>
            <dt>Monthly spend</dt>
            <dd>${ticket.customer.monthlySpendUsd}</dd>
          </div>
          {ticket.purchaseDate && (
            <div>
              <dt>Purchase date</dt>
              <dd>{new Date(ticket.purchaseDate).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>
        <h3>Customer message</h3>
        <blockquote className="customer-message">{ticket.message}</blockquote>
        {ticket.internalNotes.length > 0 && (
          <>
            <h3>
              Internal notes <span className="internal-tag">internal only</span>
            </h3>
            <ul className="internal-notes">
              {ticket.internalNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <TriagePanel
        triage={triage}
        loading={triageLoading}
        error={triageError}
        onRegenerate={regenerate}
      />
    </div>
  );
}
