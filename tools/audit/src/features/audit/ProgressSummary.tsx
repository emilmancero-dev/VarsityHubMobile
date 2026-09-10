import { Card, Badge } from '../../components/ui';
import { categories, labels, type Question, type Entry } from './types';
export function ProgressSummary({
  items,
  entries,
}: {
  items: Question[];
  entries: Record<string, Entry>;
}) {
  const passed = items.filter(i => entries[i.id]?.status === 'passed').length;
  const unresolved = items.filter(i => entries[i.id]?.status !== 'passed');
  const critical = unresolved.filter(i => i.severity === 'Critical').length,
    high = unresolved.filter(i => i.severity === 'High').length;
  const failed = items.filter(i => entries[i.id]?.status === 'failed').length;
  const tone = critical ? 'critical' : unresolved.length ? 'high' : 'done';
  return (
    <Card className="progress-card">
      <div className="eyebrow">Review progress</div>
      <div className="big-progress">
        {Math.round((passed / items.length) * 100)}
        <span>%</span>
      </div>
      <p>
        {passed} of {items.length} checks passed by reviewer
      </p>
      <div className="progress-track">
        <div style={{ width: `${(passed / items.length) * 100}%` }} />
      </div>
      <Badge className={tone}>
        {critical
          ? 'Critical review outstanding'
          : unresolved.length
            ? 'Review outstanding'
            : 'All checks attested'}
      </Badge>
      <div className="risk-counts">
        <div>
          <strong>{critical}</strong>
          <span>Critical open</span>
        </div>
        <div>
          <strong>{high}</strong>
          <span>High open</span>
        </div>
        <div>
          <strong>{failed}</strong>
          <span>Failed</span>
        </div>
      </div>
      <h3>Topic coverage</h3>
      {categories.map(c => {
        const group = items.filter(i => i.category === c),
          done = group.filter(i => entries[i.id]?.status === 'passed').length;
        return (
          <div className="coverage" key={c}>
            <div>
              <span>{labels[c]}</span>
              <b>
                {done}/{group.length}
              </b>
            </div>
            <progress max={group.length} value={done} aria-label={`${labels[c]} passed`} />
          </div>
        );
      })}
      <p className="fine-print">
        This measures review completion. A human attestation is not an automated security guarantee.
      </p>
    </Card>
  );
}
