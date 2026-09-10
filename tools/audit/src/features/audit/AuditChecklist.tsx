import { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, ArrowUpRight, CircleHelp, Printer } from 'lucide-react';
import { Badge, Card, Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui';
import data from './checklist.json';
import {
  automatedSchema,
  categories,
  checklistSchema,
  labels,
  ruleTypes,
  type AuditState,
  type AutomatedReport,
  type Category,
  type Entry,
} from './types';
import { blankState, download, emptyEntry, mergeStates, restoreState, STORAGE_KEY } from './state';
import { AuditSection } from './AuditSection';
import { ProgressSummary } from './ProgressSummary';
import { AuditExport } from './AuditExport';
const checklist = checklistSchema.parse(data);
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return {
      state: raw ? restoreState(raw, checklist.version) : blankState(checklist.version),
      warning: '',
      blocked: false,
    };
  } catch (e) {
    return {
      state: blankState(checklist.version),
      warning: `Saved review could not be loaded. ${e instanceof Error ? e.message : ''}`,
      blocked: true,
    };
  }
}
export function AuditChecklist() {
  const [initial] = useState(load),
    [state, setState] = useState<AuditState>(initial.state),
    [warning, setWarning] = useState(initial.warning),
    [blocked, setBlocked] = useState(initial.blocked);
  const params = new URLSearchParams(window.location.search),
    linkedItem = checklist.items.find(i => i.id === params.get('item'));
  const initialCategory =
    linkedItem?.category ??
    (categories.includes(params.get('section') as Category) ? params.get('section')! : 'auth');
  const [category, setCategory] = useState(initialCategory),
    [query, setQuery] = useState(''),
    [severity, setSeverity] = useState('all'),
    [rule, setRule] = useState('all'),
    [reviewer, setReviewer] = useState(''),
    [exportError, setExportError] = useState(''),
    [automated, setAutomated] = useState<AutomatedReport | null>(null);
  useEffect(() => {
    if (blocked || !state.started) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const merged = raw ? mergeStates(state, restoreState(raw, checklist.version)) : state;
      const serialized = JSON.stringify(merged);
      if (serialized !== JSON.stringify(state)) setState(merged);
      if (raw !== serialized) localStorage.setItem(STORAGE_KEY, serialized);
    } catch (e) {
      setWarning(
        `Progress is held in this tab only. Storage is unavailable or incompatible; export before closing. ${e instanceof Error ? e.message : ''}`
      );
    }
  }, [state, blocked]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const incoming = restoreState(event.newValue, checklist.version);
        setState(old => mergeStates(old, incoming));
      } catch {
        setWarning(
          'Another tab saved an incompatible review. This tab is in memory only; export before closing.'
        );
        setBlocked(true);
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    if (linkedItem && state.started)
      document.getElementById(linkedItem.id)?.scrollIntoView({ block: 'center' });
  }, [state.started, linkedItem?.id]);
  function update(id: string, patch: Partial<Entry>) {
    setState(old => {
      const timestamp = Math.max(Date.now(), old.updatedAt + 1);
      return {
        ...old,
        updatedAt: timestamp,
        entries: {
          ...old.entries,
          [id]: {
            ...(old.entries[id] ?? emptyEntry),
            ...patch,
            reviewer: reviewer.trim(),
            updatedAt: timestamp,
          },
        },
      };
    });
  }
  function startFresh() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) download('previous-audit-state.json', raw, 'application/json');
      localStorage.removeItem(STORAGE_KEY);
      setBlocked(false);
      setWarning('');
    } catch {
      setWarning('Storage is unavailable. Export this review before closing the tab.');
    }
    setState({ ...blankState(checklist.version), started: true, updatedAt: Date.now() });
  }
  async function importAutomated(file: File) {
    try {
      if (file.size > 2_000_000) throw new Error('Report exceeds 2 MB');
      const report = automatedSchema.parse(JSON.parse(await file.text()));
      if (report.checklistVersion !== checklist.version)
        throw new Error('CI report checklist version differs from this checklist');
      const counts = {
        passed: report.checks.filter(c => c.status === 'passed').length,
        failed: report.checks.filter(c => c.status === 'failed').length,
        needsReview: report.checks.filter(c => c.status === 'needs-review').length,
      };
      if (
        counts.passed !== report.summary.passed ||
        counts.failed !== report.summary.failed ||
        counts.needsReview !== report.summary.needsReview
      )
        throw new Error('Report summary does not match its checks');
      setAutomated(report);
      setExportError('');
    } catch (e) {
      setExportError(`Cannot import report: ${e instanceof Error ? e.message : 'invalid report'}`);
    }
  }
  const visible = useMemo(
    () =>
      checklist.items.filter(
        i =>
          (query.trim() || category === 'all' || i.category === category) &&
          (severity === 'all' ||
            (severity === 'urgent'
              ? ['Critical', 'High'].includes(i.severity)
              : i.severity === severity)) &&
          (rule === 'all' || i.ruleType === rule) &&
          `${i.title} ${i.category} ${labels[i.category]} ${i.affectedFiles.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase().trim())
      ),
    [query, category, severity, rule]
  );
  const reportLink =
    automated?.source.runUrl &&
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(automated.source.runUrl)
      ? automated.source.runUrl
      : null;
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/audit">
          <span className="brand-mark">
            <ShieldCheck size={22} />
          </span>
          VarsityHub
          <span className="brand-divider" />
          Engineering
        </a>
        <div className="topbar-right">
          <span className="local-dot" />
          Local review <Badge>v{checklist.version}</Badge>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">Security & architecture</div>
            <h1>Build trust. Verify the details.</h1>
            <p>A working review of the boundaries that keep VarsityHub reliable.</p>
          </div>
          <button className="print-button" onClick={() => window.print()}>
            <Printer size={16} />
            Print visible checks
          </button>
        </div>
        {warning && (
          <div className="notice warning" role="alert">
            {warning}
            {blocked && <button onClick={startFresh}>Download old state & start fresh</button>}
          </div>
        )}
        {exportError && (
          <div className="notice warning" role="alert">
            {exportError}
          </div>
        )}
        {!state.started ? (
          <Card className="intro">
            <ShieldCheck size={36} />
            <div className="eyebrow">A stronger foundation starts here</div>
            <h2>Security audit not started</h2>
            <p>
              54 checks. Eight topics. One evidence trail.
              <br />
              Work through the questions, record what you verified, and export a review your team
              can act on.
            </p>
            <button
              className="primary"
              onClick={() => setState(s => ({ ...s, started: true, updatedAt: Date.now() }))}
            >
              Begin audit <ArrowUpRight size={17} />
            </button>
            <span className="fine-print">
              Stored in this browser. No account or backend required.
            </span>
          </Card>
        ) : (
          <Tabs
            className="workspace"
            orientation="vertical"
            value={category}
            onValueChange={setCategory}
          >
            <aside className="navigation">
              <div className="eyebrow">Review topics</div>

              <TabsList aria-label="Audit topic">
                {['all', ...categories].map((c, index) => {
                  const items = checklist.items.filter(i => c === 'all' || i.category === c),
                    count = items.filter(i => state.entries[i.id]?.status === 'passed').length;
                  return (
                    <TabsTrigger value={c} key={c}>
                      <span className="nav-number">
                        {index === 0 ? '—' : String(index).padStart(2, '0')}
                      </span>
                      <span>{c === 'all' ? 'All checks' : labels[c as Category]}</span>
                      <span className="nav-count">
                        {count}/{items.length}
                      </span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              <div className="nav-note">
                <CircleHelp size={18} />
                <p>
                  Prove the behavior.
                  <br />
                  Save the evidence.
                  <br />
                  Then mark it passed.
                </p>
              </div>
            </aside>
            <TabsContent value={category} asChild>
              <section className="checklist-column" aria-label="Audit checklist">
                <div className="review-meta">
                  <label>
                    Reviewer
                    <input
                      value={reviewer}
                      maxLength={200}
                      onChange={e => setReviewer(e.target.value)}
                      placeholder="Your name or team"
                    />
                  </label>
                  <span>Changes save locally</span>
                </div>
                <div className="filterbar">
                  <label className="search">
                    <Search size={17} />
                    <input
                      aria-label="Search checks"
                      placeholder="Search checks, topics, or files…"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                    />
                  </label>
                  <div className="filter-row">
                    <select
                      aria-label="Severity filter"
                      value={severity}
                      onChange={e => setSeverity(e.target.value)}
                    >
                      <option value="all">All severities</option>
                      <option value="urgent">Critical + High</option>
                      {['Critical', 'High', 'Medium', 'Low'].map(s => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Rule type filter"
                      value={rule}
                      onChange={e => setRule(e.target.value)}
                    >
                      <option value="all">All rule types</option>
                      {ruleTypes.map(r => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <span>{visible.length} checks</span>
                  </div>
                </div>
                {visible.length === 0 ? (
                  <Card className="no-results">
                    No checks match these filters.
                    <button
                      onClick={() => {
                        setQuery('');
                        setRule('all');
                        setSeverity('all');
                      }}
                    >
                      Clear filters
                    </button>
                  </Card>
                ) : (
                  categories.map(c => {
                    const items = visible.filter(i => i.category === c);
                    return items.length ? (
                      <AuditSection
                        key={c}
                        category={c}
                        items={items}
                        entries={state.entries}
                        onChange={update}
                        selectedId={linkedItem?.id ?? null}
                      />
                    ) : null;
                  })
                )}
              </section>
            </TabsContent>
            <aside className="right-rail">
              <ProgressSummary items={checklist.items} entries={state.entries} />
              <Card className="export-card">
                <h3>Take the evidence with you</h3>
                <p>Export the full checklist, reviewer notes, and unresolved items.</p>
                <AuditExport checklist={checklist} state={state} onError={setExportError} />
              </Card>
              <Card className="ci-card">
                <div className="eyebrow">Automated evidence</div>
                <Badge>{automated ? 'Imported report' : 'CI status unknown'}</Badge>
                {automated ? (
                  <>
                    <p>
                      {automated.summary.passed} passed · {automated.summary.failed} failed ·{' '}
                      {automated.summary.needsReview} need review
                    </p>
                    <p className="fine-print">
                      {new Date(automated.generatedAt).toLocaleString()} · {automated.source.type}
                      <br />
                      Imported artifact; live CI status is not verified.
                    </p>
                    {reportLink && (
                      <a href={reportLink} target="_blank" rel="noreferrer">
                        Verify run on GitHub ↗
                      </a>
                    )}
                    <details>
                      <summary>View check evidence</summary>
                      {automated.checks.map(c => (
                        <div className="ci-check" key={c.id}>
                          <strong>{c.title}</strong>
                          <Badge>{c.status}</Badge>
                          <p>{c.details}</p>
                          {c.evidence.map((e, i) => (
                            <pre key={i}>{e}</pre>
                          ))}
                        </div>
                      ))}
                    </details>
                  </>
                ) : (
                  <p>Import an audit-report.json from a local run or GitHub Actions.</p>
                )}
                <label className="import-button">
                  Import automated report
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) void importAutomated(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </Card>
            </aside>
          </Tabs>
        )}
        <footer>
          <span>VarsityHub / Engineering assurance</span>
          <span>Human judgment, backed by evidence.</span>
        </footer>
      </main>
    </>
  );
}
