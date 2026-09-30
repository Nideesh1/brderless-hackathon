import type { TriageResult } from '../../shared/types';

interface Props {
  triage: TriageResult | null;
  loading: boolean;
  error: string | null;
  onRegenerate: () => void;
}

export function TriagePanel({ triage, loading, error, onRegenerate }: Props) {
  return (
    <section className="triage-panel card">
      <div className="triage-header">
        <h3>AI Triage</h3>
        <button onClick={onRegenerate} disabled={loading}>
          {loading ? 'Generating…' : 'Regenerate AI Triage'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!triage && !error && (
        <div className="empty-state">{loading ? 'Running AI triage…' : 'No triage yet.'}</div>
      )}

      {triage && (
        <div className={loading ? 'triage-body loading' : 'triage-body'}>
          <div className="triage-badges">
            <span className={`badge badge-category`}>{triage.category}</span>
            <span className={`badge badge-${triage.urgency}`}>{triage.urgency}</span>
            <span className={`badge ${triage.escalate ? 'badge-escalate' : 'badge-noescalate'}`}>
              {triage.escalate ? 'Escalate' : 'No escalation'}
            </span>
          </div>

          {triage.warnings.length > 0 && (
            <div className="error-banner" role="alert">
              <strong>Review before sending:</strong>
              <ul>
                {triage.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {triage.escalationReasons.length > 0 && (
            <>
              <h4>Why escalate</h4>
              <ul className="escalation-reasons">
                {triage.escalationReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}

          <h4>Drafted reply</h4>
          <pre className="drafted-reply">{triage.reply}</pre>

          <h4>Reasoning</h4>
          <p className="reasoning">{triage.reasoning}</p>

          <h4>Policy context used</h4>
          <ul className="citations">
            {triage.citations.map((c) => (
              <li key={c.docId}>
                <strong>{c.title}</strong>
                <span className="snippet">{c.snippet}</span>
              </li>
            ))}
          </ul>

          <div className="triage-footer">
            Generated {new Date(triage.generatedAt).toLocaleTimeString()}
          </div>
        </div>
      )}
    </section>
  );
}
