import { z } from 'zod';
export const categories = [
  'auth',
  'validation',
  'crypto',
  'api',
  'frontend',
  'infra',
  'observability',
  'performance',
] as const;
export const labels: Record<Category, string> = {
  auth: 'Authentication & identity',
  validation: 'Data validation',
  crypto: 'Cryptography & secrets',
  api: 'API security',
  frontend: 'Frontend security',
  infra: 'Infrastructure & deployment',
  observability: 'Observability & response',
  performance: 'Performance & scalability',
};
export const severities = ['Critical', 'High', 'Medium', 'Low'] as const;
export const statuses = ['unchecked', 'in-progress', 'passed', 'failed'] as const;
export const ruleTypes = [
  'Audit Steps',
  'Engineering Standards',
  'Business Rules',
  'Release Gates',
] as const;
export const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(categories),
  ruleType: z.enum(ruleTypes),
  severity: z.enum(severities),
  description: z.string(),
  verification: z.string().min(1),
  affectedFiles: z.array(z.string()),
  remediation: z.string(),
  codeExample: z.string().optional(),
});
export const checklistSchema = z
  .object({ version: z.string(), title: z.string(), items: z.array(itemSchema) })
  .refine(c => new Set(c.items.map(i => i.id)).size === c.items.length, 'Duplicate checklist IDs');
export const entrySchema = z.object({
  status: z.enum(statuses),
  notes: z.string().max(100000),
  reviewer: z.string().max(200),
  updatedAt: z.number().nonnegative(),
});
export const stateSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  checklistVersion: z.string(),
  started: z.boolean(),
  updatedAt: z.number().nonnegative(),
  entries: z.record(entrySchema),
});
export const automatedSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  checklistVersion: z.string(),
  generatedAt: z.string().datetime(),
  kind: z.literal('automated'),
  source: z.object({
    type: z.enum(['local', 'github-actions']),
    commit: z.string().optional(),
    runUrl: z.string().url().optional(),
  }),
  summary: z.object({
    passed: z.number().nonnegative(),
    failed: z.number().nonnegative(),
    needsReview: z.number().nonnegative(),
  }),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(severities),
      status: z.enum(['passed', 'failed', 'needs-review']),
      details: z.string(),
      evidence: z.array(z.string()),
    })
  ),
});
export type Category = (typeof categories)[number];
export type Checklist = z.infer<typeof checklistSchema>;
export type Question = z.infer<typeof itemSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type AuditState = z.infer<typeof stateSchema>;
export type AutomatedReport = z.infer<typeof automatedSchema>;
