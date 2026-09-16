#!/usr/bin/env npx tsx
/**
 * Local runtime verification for the org-manager/admin-surface contract.
 *
 * Scope:
 * - Fresh fan signup can register, log in, complete onboarding, and is still
 *   blocked from coach/team creation.
 * - A fan-role user with an active org `manager` membership can reach the same
 *   org-admin API surfaces the client now exposes.
 * - A normal public fan still cannot submit an organization join request.
 *
 * This script mutates local data and is intended for localhost only.
 *
 * Usage:
 *   npm --prefix server run verify:org-manager-access
 */

import type { Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  COACH_ROUTE_BATTERY_LOCAL_EMAIL,
  disconnectCoachUatAccountsPrisma,
  prepareCoachUatAccounts,
} from './prepare-coach-uat-accounts.js';

type StepResult = {
  step: string;
  ok: boolean;
  status?: number;
  detail?: string;
};

type AuthUserBody = {
  role?: string | null;
  onboarding_completed?: boolean;
};

type LoginBody = {
  access_token?: string;
  refresh_token?: string;
  user?: {
    id?: string;
  } | null;
};

type OrganizationBody = {
  viewer_role?: string | null;
  can_manage?: boolean;
  can_edit?: boolean;
};

type ReviewSummaryBody = Array<{
  organization?: { id?: string | null; name?: string | null } | null;
  permissions?: {
    can_manage?: boolean;
    membership_role?: string | null;
  } | null;
}> | null;

type AdminSummaryBody = {
  organization?: {
    viewer_role?: string | null;
    can_manage?: boolean;
    can_edit?: boolean;
  } | null;
  permissions?: {
    can_manage?: boolean;
    membership_role?: string | null;
  } | null;
} | null;

const prisma = new PrismaClient();
let BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:0').replace(/\/$/, '');
const REPORT_PATH = String(process.env.ORG_MANAGER_VERIFY_REPORT_PATH || '').trim();

const results: StepResult[] = [];
let embeddedLocalServer: Server | null = null;

function record(step: string, ok: boolean, status?: number, detail?: string) {
  results.push({ step, ok, status, detail });
  const label = ok ? 'PASS' : 'FAIL';
  console.log(
    `[org-manager-verify] ${label} ${step}${status ? ` (${status})` : ''}${detail ? ` - ${detail}` : ''}`
  );
}

async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: T | string | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text || null;
  }
  return { status: res.status, data };
}

function isLocalBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function getBaseUrlAddress(url: string): { hostname: string; port: number } {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
  };
}

async function ensureLocalServer() {
  if (!isLocalBaseUrl(BASE_URL)) {
    throw new Error('verify-org-manager-access is local-only. Set BASE_URL to localhost.');
  }
  // Own the API process as well as its database configuration. A reachable
  // localhost server may use a different (even remote) database; never reuse it.
  const { hostname, port } = getBaseUrlAddress(BASE_URL);
  process.env.NODE_ENV = 'test';
  // Keep the localhost verifier hermetic. This script exercises auth and org
  // manager surfaces; it should not depend on live SendGrid credentials.
  process.env.EMAIL_PROVIDER = 'test';
  const { app } = await import('../src/testApp.js');

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, hostname, () => {
      embeddedLocalServer = server;
      const address = server.address();
      if (address && typeof address !== 'string') BASE_URL = `http://${hostname}:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });

  console.log(
    `[org-manager-verify] Started embedded local API on ${BASE_URL} for localhost verification.`
  );
}

async function shutdownEmbeddedLocalServer() {
  if (!embeddedLocalServer) return;
  const server = embeddedLocalServer;
  embeddedLocalServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close(err => {
      if (err) reject(err);
      else resolve();
    });
  }).catch(() => {});
}

function extractLogin(login: LoginBody, step: string) {
  const accessToken = String(login?.access_token || '');
  const userId = String(login?.user?.id || '');
  if (!accessToken || !userId) {
    throw new Error(`${step}: missing login token or user id`);
  }
  return { accessToken, userId };
}

async function deleteUserAndMemberships(userId: string) {
  await prisma.organizationMembership.deleteMany({ where: { user_id: userId } }).catch(() => {});
  await prisma.teamMembership.deleteMany({ where: { user_id: userId } }).catch(() => {});
  await prisma.organizationJoinRequest.deleteMany({ where: { user_id: userId } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { user_id: userId } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user_id: userId } }).catch(() => {});
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
}

async function registerVerifiedFan(prefix: string) {
  const stamp = Date.now();
  const email = `${prefix}_${stamp}@test.local`;
  const username = `${prefix}_${stamp}`.slice(0, 20);
  const password = 'TestPass123!';
  const dob = '2000-01-15';

  const register = await api<LoginBody>('POST', '/auth/register', {
    email,
    password,
    display_name: prefix,
    role: 'fan',
    dob,
  });

  if (![200, 201].includes(register.status)) {
    throw new Error(`${prefix}: register failed with ${register.status}`);
  }

  const { accessToken: initialToken, userId } = extractLogin(
    register.data as LoginBody,
    `${prefix} register`
  );
  await prisma.user.update({
    where: { id: userId },
    data: {
      email_verified: true,
      onboarding_completed: true,
      role: 'fan',
      approval_status: 'APPROVED',
      preferences: {
        role: 'fan',
        onboarding_completed: true,
      },
    },
  });

  const login = await api<LoginBody>('POST', '/auth/login', { email, password });
  if (login.status !== 200) {
    throw new Error(`${prefix}: login failed with ${login.status}`);
  }

  const { accessToken } = extractLogin(login.data as LoginBody, `${prefix} login`);
  return { userId, email, username, password, accessToken, initialToken };
}

async function verifyFanSignup() {
  const stamp = Date.now();
  const email = `verifyfan_${stamp}@test.local`;
  const username = `verifyfan_${stamp}`.slice(0, 20);
  const password = 'TestPass123!';
  const dob = '2000-01-15';
  const zipCode = '06907';

  const register = await api<LoginBody>('POST', '/auth/register', {
    email,
    password,
    display_name: 'Verify Fan',
    role: 'fan',
    dob,
  });
  record('fan register', [200, 201].includes(register.status), register.status);
  if (![200, 201].includes(register.status)) return null;

  const { accessToken: initialToken, userId } = extractLogin(
    register.data as LoginBody,
    'fan register'
  );
  await prisma.user.update({ where: { id: userId }, data: { email_verified: true } });

  const login = await api<LoginBody>('POST', '/auth/login', { email, password });
  record('fan login', login.status === 200, login.status);
  if (login.status !== 200) {
    await deleteUserAndMemberships(userId);
    return null;
  }

  const { accessToken } = extractLogin(login.data as LoginBody, 'fan login');
  const onboarding = await api(
    'POST',
    '/me/complete-onboarding',
    {
      role: 'fan',
      username,
      dob,
      zip_code: zipCode,
      affiliation: 'none',
    },
    accessToken
  );
  record('fan onboarding', onboarding.status === 200, onboarding.status);

  const me = await api<AuthUserBody>('GET', '/auth/me', undefined, accessToken);
  const meOk =
    me.status === 200 &&
    String((me.data as AuthUserBody | null)?.role || '').toLowerCase() === 'fan' &&
    (me.data as AuthUserBody | null)?.onboarding_completed === true;
  record(
    'fan /auth/me',
    meOk,
    me.status,
    `role=${String((me.data as AuthUserBody | null)?.role || '')}`
  );

  const teamCreate = await api(
    'POST',
    '/teams',
    {
      name: 'Fan Team Attempt',
      organization_id: 'fake-org-id',
    },
    accessToken
  );
  record('fan blocked from /teams', teamCreate.status === 403, teamCreate.status);

  await deleteUserAndMemberships(userId);
  return {
    userId,
    initialToken,
    ok: onboarding.status === 200 && meOk && teamCreate.status === 403,
  };
}

async function verifyManagerAccess() {
  await prepareCoachUatAccounts();

  const rookieCoach = await prisma.user.findUnique({
    where: { email: COACH_ROUTE_BATTERY_LOCAL_EMAIL },
    select: { organization_id: true },
  });
  if (!rookieCoach?.organization_id) {
    throw new Error('rookie coach fixture missing organization');
  }

  const managerFan = await registerVerifiedFan('managerfan');
  await prisma.organizationMembership.upsert({
    where: {
      organization_id_user_id: {
        organization_id: rookieCoach.organization_id,
        user_id: managerFan.userId,
      },
    },
    update: { role: 'manager', status: 'active' },
    create: {
      organization_id: rookieCoach.organization_id,
      user_id: managerFan.userId,
      role: 'manager',
      status: 'active',
    },
  });

  const me = await api<AuthUserBody>('GET', '/auth/me', undefined, managerFan.accessToken);
  const reviewSummaries = await api<ReviewSummaryBody>(
    'GET',
    '/organizations/mine/review-summaries',
    undefined,
    managerFan.accessToken
  );
  const org = await api<OrganizationBody>(
    'GET',
    `/organizations/${encodeURIComponent(rookieCoach.organization_id)}`,
    undefined,
    managerFan.accessToken
  );
  const adminSummary = await api<AdminSummaryBody>(
    'GET',
    `/organizations/${encodeURIComponent(rookieCoach.organization_id)}/admin-summary`,
    undefined,
    managerFan.accessToken
  );
  const pendingEvents = await api('GET', '/events/pending', undefined, managerFan.accessToken);

  const firstSummary = Array.isArray(reviewSummaries.data) ? reviewSummaries.data[0] : null;
  record(
    'manager fan stays role=fan',
    me.status === 200 &&
      String((me.data as AuthUserBody | null)?.role || '').toLowerCase() === 'fan',
    me.status
  );
  record(
    'manager review summaries',
    reviewSummaries.status === 200 &&
      Array.isArray(reviewSummaries.data) &&
      reviewSummaries.data.length >= 1 &&
      firstSummary?.permissions?.can_manage === true &&
      firstSummary?.permissions?.membership_role === 'manager',
    reviewSummaries.status,
    `role=${String(firstSummary?.permissions?.membership_role || '')}`
  );
  record(
    'manager org detail flags',
    org.status === 200 &&
      (org.data as OrganizationBody | null)?.viewer_role === 'manager' &&
      (org.data as OrganizationBody | null)?.can_manage === true &&
      (org.data as OrganizationBody | null)?.can_edit === false,
    org.status,
    `viewer_role=${String((org.data as OrganizationBody | null)?.viewer_role || '')}`
  );
  record(
    'manager admin summary',
    adminSummary.status === 200 &&
      (adminSummary.data as AdminSummaryBody | null)?.organization?.viewer_role === 'manager' &&
      (adminSummary.data as AdminSummaryBody | null)?.organization?.can_manage === true &&
      (adminSummary.data as AdminSummaryBody | null)?.organization?.can_edit === false &&
      (adminSummary.data as AdminSummaryBody | null)?.permissions?.can_manage === true &&
      (adminSummary.data as AdminSummaryBody | null)?.permissions?.membership_role === 'manager',
    adminSummary.status
  );
  record('manager pending events', pendingEvents.status === 200, pendingEvents.status);

  await deleteUserAndMemberships(managerFan.userId);
}

async function verifyPublicFanJoinBlock() {
  const rookieCoach = await prisma.user.findUnique({
    where: { email: COACH_ROUTE_BATTERY_LOCAL_EMAIL },
    select: { organization_id: true },
  });
  if (!rookieCoach?.organization_id) {
    throw new Error('rookie coach fixture missing organization for public fan probe');
  }

  const publicFan = await registerVerifiedFan('publicfan');
  const org = await api<OrganizationBody>(
    'GET',
    `/organizations/${encodeURIComponent(rookieCoach.organization_id)}`,
    undefined,
    publicFan.accessToken
  );
  const joinRequest = await api(
    'POST',
    '/organizations/join-requests',
    { organization_id: rookieCoach.organization_id },
    publicFan.accessToken
  );

  record(
    'public fan org detail has no admin flags',
    org.status === 200 &&
      ((org.data as OrganizationBody | null)?.viewer_role || null) === null &&
      (org.data as OrganizationBody | null)?.can_manage !== true &&
      (org.data as OrganizationBody | null)?.can_edit !== true,
    org.status
  );
  record(
    'public fan join request blocked',
    joinRequest.status === 403 &&
      String((joinRequest.data as any)?.error || '').includes('Upgrade to a coach account'),
    joinRequest.status
  );

  await deleteUserAndMemberships(publicFan.userId);
}

async function writeReport() {
  const payload = {
    ok: results.every(result => result.ok),
    baseUrl: BASE_URL,
    ranAt: new Date().toISOString(),
    results,
  };

  if (REPORT_PATH) {
    await writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[org-manager-verify] Wrote report to ${REPORT_PATH}`);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  try {
    await ensureLocalServer();
    await verifyFanSignup();
    await verifyManagerAccess();
    await verifyPublicFanJoinBlock();
    await writeReport();
    return results.every(result => result.ok) ? 0 : 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
    await disconnectCoachUatAccountsPrisma().catch(() => {});
    await shutdownEmbeddedLocalServer().catch(() => {});
  }
}

main()
  .catch(async error => {
    record('fatal', false, undefined, error instanceof Error ? error.message : String(error));
    await writeReport().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    await disconnectCoachUatAccountsPrisma().catch(() => {});
    await shutdownEmbeddedLocalServer().catch(() => {});
    console.error('[org-manager-verify] fatal:', error);
    process.exit(1);
  })
  .then(code => {
    if (typeof code === 'number') {
      process.exit(code);
    }
  });
