import { AuditItem } from './AuditItem';
import { emptyEntry } from './state';
import { labels, type Category, type Question, type Entry } from './types';
export function AuditSection({
  category,
  items,
  entries,
  onChange,
  selectedId,
}: {
  category: Category;
  items: Question[];
  entries: Record<string, Entry>;
  onChange: (id: string, patch: Partial<Entry>) => void;
  selectedId: string | null;
}) {
  const passed = items.filter(i => entries[i.id]?.status === 'passed').length;
  return (
    <details className="audit-section" open>
      <summary className="section-heading">
        <h2>{labels[category]}</h2>
        <span>
          {passed}/{items.length} passed <span aria-hidden="true">⌄</span>
        </span>
      </summary>
      <div>
        {items.map(item => (
          <AuditItem
            key={item.id}
            item={item}
            entry={entries[item.id] ?? emptyEntry}
            expanded={selectedId === item.id}
            onChange={patch => onChange(item.id, patch)}
          />
        ))}
      </div>
    </details>
  );
}
