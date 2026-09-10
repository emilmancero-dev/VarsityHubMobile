import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { checklistSchema } from '../src/features/audit/types';
import { blankState, buildReport, toMarkdown } from '../src/features/audit/state';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const checklist = checklistSchema.parse(
  JSON.parse(readFileSync(resolve(root, 'tools/audit/src/features/audit/checklist.json'), 'utf8'))
);
const report = buildReport(checklist, blankState(checklist.version));
writeFileSync(
  resolve(root, 'tools/audit/public/sample-report.json'),
  JSON.stringify(report, null, 2) + '\n'
);
writeFileSync(resolve(root, 'tools/audit/public/sample-report.md'), toMarkdown(report));
const markdown = readFileSync(resolve(root, 'docs/AUDIT_COMMANDMENTS.md'), 'utf8');
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const rows = markdown
  .split('\n')
  .filter(line => /^\| \d/.test(line))
  .map(line =>
    line
      .split('|')
      .slice(1, -1)
      .map(cell =>
        escape(
          cell
            .trim()
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replaceAll('`', '')
        )
      )
  );
const browser = await chromium.launch({ channel: process.env.AUDIT_BROWSER_CHANNEL || undefined });
try {
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>@page{size:A4;margin:15mm}body{font-family:Arial,sans-serif;color:#173d35;font-size:10px;line-height:1.5}header{border-bottom:3px solid #173d35;padding-bottom:15px;margin-bottom:15px}h1{font-size:28px;letter-spacing:-1px;margin:6px 0}small{letter-spacing:1px;font-weight:bold}table{border-collapse:collapse;width:100%}td{padding:10px 7px;border-bottom:1px solid #ccc;vertical-align:top}td:first-child{font-weight:bold;width:22px}td:nth-child(2){font-weight:bold;width:175px}footer{margin-top:18px;border-top:2px solid #173d35;padding-top:12px}p{margin:8px 0}</style></head><body><header><small>VARSITYHUB / ENGINEERING ASSURANCE</small><h1>The 12 Audit Commandments</h1><p>Framework v1.0.0 · Evidence before approval</p></header><p>Audit Steps investigate. Engineering Standards structure. Business Rules protect product invariants. Release Gates decide readiness.</p><table>${rows.map(c => `<tr>${c.map(s => `<td>${s}</td>`).join('')}</tr>`).join('')}</table><footer><strong>Unchecked is not passed.</strong> Missing evidence stays unresolved. Critical/High failed gates block release; scans alone cannot prove behavioral security.<p>Full rules: docs/AUDIT_FRAMEWORK.md · Finding template: templates/AUDIT_REPORT.md</p></footer></body></html>`
  );
  await page.pdf({
    path: resolve(root, 'docs/AUDIT_COMMANDMENTS.pdf'),
    format: 'A4',
    printBackground: true,
  });
} finally {
  await browser.close();
}
console.log('Generated unresolved sample reports and commandments PDF.');
