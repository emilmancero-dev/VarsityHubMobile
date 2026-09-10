import { Badge, Checkbox } from '../../components/ui';
import { statuses, type Entry, type Question } from './types';
export function AuditItem({
  item,
  entry,
  onChange,
  expanded = false,
}: {
  item: Question;
  entry: Entry;
  onChange: (patch: Partial<Entry>) => void;
  expanded?: boolean;
}) {
  return (
    <article
      className={`audit-item severity-${item.severity.toLowerCase()} ${entry.status === 'passed' ? 'is-passed' : ''}`}
      id={item.id}
    >
      <div className="item-top">
        <Checkbox
          aria-label={`Pass: ${item.title}`}
          checked={entry.status === 'passed'}
          onCheckedChange={checked => onChange({ status: checked ? 'passed' : 'unchecked' })}
        />
        <span className="item-id">{item.id}</span>
        <Badge className={`severity ${item.severity.toLowerCase()}`}>{item.severity}</Badge>
        {entry.status === 'passed' && <Badge className="done">✓ Done</Badge>}
        {entry.status === 'failed' && <Badge className="critical">Failed</Badge>}
      </div>
      <details open={expanded || undefined}>
        <summary>
          <span>{item.title}</span>
          <span className="expand-icon" aria-hidden="true">
            +
          </span>
        </summary>
        <div className="item-details">
          <Badge>{item.ruleType}</Badge>
          <p>{item.description}</p>
          <h4>How to verify</h4>
          <p>{item.verification}</p>
          <h4>Remediation</h4>
          <p>
            {item.remediation ||
              'Record an issue in the project repository with reproduction steps.'}
          </p>
          {item.codeExample && (
            <pre>
              <code>{item.codeExample}</code>
            </pre>
          )}
          <h4>Affected files</h4>
          <div className="paths">
            {item.affectedFiles.map(path => (
              <code key={path}>{path}</code>
            ))}
          </div>
          <fieldset>
            <legend>Review status</legend>
            <div className="status-options">
              {statuses.map(status => (
                <label key={status}>
                  <input
                    type="radio"
                    name={`status-${item.id}`}
                    checked={entry.status === status}
                    onChange={() => onChange({ status })}
                  />
                  {status.replace('-', ' ')}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="notes-label" htmlFor={`notes-${item.id}`}>
            Evidence & notes {entry.status === 'failed' && <span>(required for export)</span>}
          </label>
          <textarea
            id={`notes-${item.id}`}
            rows={3}
            maxLength={100000}
            value={entry.notes}
            onChange={e => onChange({ notes: e.target.value })}
            placeholder="What did you run? Record the result, commit, or evidence link. Avoid secrets and personal data."
          />
          {entry.updatedAt > 0 && (
            <p className="edit-stamp">
              Edited by {entry.reviewer || 'unnamed reviewer'} ·{' '}
              {new Date(entry.updatedAt).toLocaleString()}
            </p>
          )}
          <a className="item-link" href={`?section=${item.category}&item=${item.id}`}>
            Link to this check ↗
          </a>
        </div>
      </details>
    </article>
  );
}
