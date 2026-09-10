import { test, expect } from '@playwright/test';
test('review, filter, export, reload and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/audit');
  await page.getByRole('button', { name: 'Begin audit' }).click();
  await expect(page.locator('.audit-item')).toHaveCount(7);
  await page.getByPlaceholder('Your name or team').fill('Test reviewer');
  const checkbox = page.getByRole('checkbox').first();
  await checkbox.check();
  await expect(page.locator('.big-progress')).toContainText('2');
  await page.reload();
  await expect(page.getByRole('checkbox').first()).toBeChecked();
  await page.getByRole('tab', { name: /All checks/ }).click();
  await expect(page.locator('.audit-item')).toHaveCount(54);
  await page.getByLabel('Severity filter').selectOption('Critical');
  const badges = await page.locator('.item-top .severity').allTextContents();
  expect(badges.length).toBeGreaterThan(0);
  expect(badges.every(s => s === 'Critical')).toBe(true);
  await page.getByLabel('Severity filter').selectOption('all');
  await page.getByLabel('Search checks').fill('server/src');
  expect(await page.locator('.audit-item').count()).toBeGreaterThan(0);
  await page.getByLabel('Search checks').fill('zz-no-match');
  await expect(page.getByText('No checks match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  const first = page.locator('.audit-item').first();
  await first.locator('summary').click();
  await first.getByRole('radio', { name: 'failed', exact: true }).check();
  await page.getByRole('button', { name: 'Export JSON' }).click();
  await expect(page.getByRole('alert')).toContainText('Add notes');
  await first.locator('textarea').fill('Reproduced ownership failure with two fixture users.');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const dl = await downloadEvent;
  expect(dl.suggestedFilename()).toMatch(/audit.*json/);
  const stream = await dl.createReadStream();
  let raw = '';
  for await (const chunk of stream!) raw += chunk.toString();
  const report = JSON.parse(raw);
  expect(report.items).toHaveLength(54);
  expect(report.summary.failed).toBe(1);
  expect(report.items[0].notes).toContain('fixture users');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.right-rail')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('deep link, keyboard operation and cross-tab reconciliation', async ({ page, context }) => {
  await page.goto('/audit?section=auth&item=password-hashing');
  await page.getByRole('button', { name: 'Begin audit' }).click();
  await expect(page.locator('#password-hashing details')).toHaveAttribute('open', '');
  const checkbox = page.getByRole('checkbox').first();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  const other = await context.newPage();
  await other.goto('/audit');
  await expect(other.getByRole('checkbox').first()).toBeChecked();
  await other.getByRole('checkbox').nth(1).check();
  await expect(page.getByRole('checkbox').nth(1)).toBeChecked();
  await page.reload();
  await expect(page.getByRole('checkbox').first()).toBeChecked();
  await expect(page.getByRole('checkbox').nth(1)).toBeChecked();
});
test('storage denial keeps a usable in-memory review', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'setItem', {
      value: () => {
        throw new Error('Quota exceeded');
      },
    });
  });
  await page.goto('/audit');
  await page.getByRole('button', { name: 'Begin audit' }).click();
  await page.getByRole('checkbox').first().check();
  await expect(page.getByRole('alert')).toContainText('this tab only');
  await expect(page.getByRole('checkbox').first()).toBeChecked();
});
test('old checklist versions warn and preserve old evidence', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'varsityhub.audit.review',
      JSON.stringify({
        schemaVersion: '1.0.0',
        checklistVersion: '0.8.0',
        started: true,
        updatedAt: 1,
        entries: {},
      })
    )
  );
  await page.goto('/audit');
  await expect(page.getByRole('alert')).toContainText('version');
  await expect(
    page.getByRole('button', { name: 'Download old state & start fresh' })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('varsityhub.audit.review')!).checklistVersion
    )
  ).toBe('0.8.0');
});
test('imported automated evidence is never presented as live CI status', async ({ page }) => {
  await page.goto('/audit');
  await page.getByRole('button', { name: 'Begin audit' }).click();
  await expect(page.getByText('CI status unknown')).toBeVisible();
  const report = {
    schemaVersion: '1.0.0',
    checklistVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    kind: 'automated',
    source: { type: 'github-actions', runUrl: 'https://github.com/example/repo/actions/runs/123' },
    summary: { passed: 1, failed: 0, needsReview: 0 },
    checks: [
      {
        id: 'fixture',
        title: 'Fixture evidence',
        severity: 'High',
        status: 'passed',
        details: 'Test fixture; not a real CI run',
        evidence: ['fixture only'],
      },
    ],
  };
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'report.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(report)),
    });
  await expect(page.getByText('Imported report', { exact: true })).toBeVisible();
  await expect(page.getByText(/live CI status is not verified/)).toBeVisible();
  report.summary.passed = 2;
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(report)),
    });
  await expect(page.getByRole('alert')).toContainText('does not match');
  const summary = page.locator('.audit-item summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.audit-item details').first()).toHaveAttribute('open', '');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  expect((await event).suggestedFilename()).toMatch(/\.md$/);
});
