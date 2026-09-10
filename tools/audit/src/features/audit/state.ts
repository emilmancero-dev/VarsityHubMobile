import { stateSchema, categories, type AuditState, type Checklist, type Entry } from './types';
export const STORAGE_KEY = 'varsityhub.audit.review';
export const blankState = (version: string): AuditState => ({
  schemaVersion: '1.0.0',
  checklistVersion: version,
  started: false,
  updatedAt: 0,
  entries: {},
});
export const emptyEntry: Entry = { status: 'unchecked', notes: '', reviewer: '', updatedAt: 0 };
export function restoreState(raw: string, version: string): AuditState {
  const value = stateSchema.parse(JSON.parse(raw));
  if (value.checklistVersion !== version)
    throw new Error(
      `Checklist version ${value.checklistVersion} differs from ${version}. Export the old review before starting a new one.`
    );
  return value;
}
export function mergeStates(a: AuditState, b: AuditState): AuditState {
  if (a.checklistVersion !== b.checklistVersion)
    throw new Error('Cannot merge different checklist versions');
  const entries = { ...a.entries };
  for (const [id, value] of Object.entries(b.entries)) {
    const old = entries[id];
    if (
      !old ||
      value.updatedAt > old.updatedAt ||
      (value.updatedAt === old.updatedAt && JSON.stringify(value) > JSON.stringify(old))
    )
      entries[id] = value;
  }
  return {
    ...a,
    started: a.started || b.started,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    entries,
  };
}
export function buildReport(checklist: Checklist, state: AuditState) {
  if (state.checklistVersion !== checklist.version) throw new Error('Checklist version mismatch');
  const items = checklist.items.map(item => ({
    ...item,
    ...(state.entries[item.id] ?? emptyEntry),
  }));
  const missing = items.filter(i => i.status === 'failed' && !i.notes.trim());
  if (missing.length)
    throw new Error(
      `Add notes to ${missing.length} failed item(s) before exporting: ${missing.map(i => i.id).join(', ')}`
    );
  const summary = {
    total: items.length,
    passed: items.filter(i => i.status === 'passed').length,
    failed: items.filter(i => i.status === 'failed').length,
    inProgress: items.filter(i => i.status === 'in-progress').length,
    unchecked: items.filter(i => i.status === 'unchecked').length,
  };
  const categoryBreakdown = Object.fromEntries(
    categories.map(c => {
      const group = items.filter(i => i.category === c);
      return [
        c,
        {
          total: group.length,
          passed: group.filter(i => i.status === 'passed').length,
          failed: group.filter(i => i.status === 'failed').length,
        },
      ];
    })
  );
  return {
    schemaVersion: '1.0.0',
    checklistVersion: checklist.version,
    kind: 'human-review',
    generatedAt: new Date().toISOString(),
    lastUpdated: state.updatedAt,
    summary,
    categoryBreakdown,
    uncheckedItems: items.filter(i => i.status !== 'passed').map(i => i.id),
    items,
  };
}
export function toMarkdown(report: ReturnType<typeof buildReport>): string {
  const clean = (s: string) => s.replace(/\r/g, '');
  return [
    `# VarsityHub security & architecture audit`,
    ``,
    `Human review attestations — automated checks are reported separately.`,
    ``,
    `Checklist: ${report.checklistVersion} · Exported: ${report.generatedAt}`,
    ``,
    `Passed: ${report.summary.passed}/${report.summary.total} · Failed: ${report.summary.failed} · In progress: ${report.summary.inProgress} · Unchecked: ${report.summary.unchecked}`,
    ``,
    ...report.items.flatMap(i => [
      `## ${i.id} — ${clean(i.title)}`,
      ``,
      `**${i.status === 'passed' ? 'PASSED' : 'UNRESOLVED: ' + i.status}** · ${i.severity} · ${i.category} · ${i.ruleType}`,
      ``,
      `Verification: ${clean(i.verification)}`,
      ``,
      `Affected files: ${i.affectedFiles.join(', ')}`,
      ``,
      `Reviewer: ${clean(i.reviewer) || 'Not recorded'}`,
      ``,
      `Notes: ${clean(i.notes) || 'No evidence recorded'}`,
      ``,
    ]),
  ].join('\n');
}
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
