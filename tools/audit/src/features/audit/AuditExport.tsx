import { Download, FileText } from 'lucide-react';
import { buildReport, download, toMarkdown } from './state';
import type { AuditState, Checklist } from './types';
export function AuditExport({
  checklist,
  state,
  onError,
}: {
  checklist: Checklist;
  state: AuditState;
  onError: (message: string) => void;
}) {
  function run(format: 'json' | 'md') {
    try {
      const report = buildReport(checklist, state);
      download(
        `varsityhub-audit-${new Date().toISOString().slice(0, 10)}.${format}`,
        format === 'json' ? JSON.stringify(report, null, 2) : toMarkdown(report),
        format === 'json' ? 'application/json' : 'text/markdown'
      );
      onError('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Export failed');
    }
  }
  return (
    <div className="export-buttons">
      <button onClick={() => run('json')}>
        <Download size={15} />
        Export JSON
      </button>
      <button onClick={() => run('md')}>
        <FileText size={15} />
        Markdown
      </button>
    </div>
  );
}
