import fs from 'node:fs';
import path from 'node:path';

/**
 * [AUDIT] Validation-parity guard.
 *
 * CLAUDE.md states: "frontend constraints match the backend Zod schema —
 * username (3–20), email format, password (8+)". Client TS and server Zod
 * compile independently and can silently diverge, so this test pins the shared
 * constraints as a single canonical spec and asserts BOTH sides still encode
 * them.
 *
 * Deliberately source-based (fs reads, no imports): importing the route modules
 * would pull in Prisma/Express side effects, and the guard's job is to detect a
 * human editing one side without the other — exactly what reading the source
 * verifies. Same approach as scripts/verify-guardrails.sh and audit-navigation.sh.
 *
 * If you intentionally change a constraint, update CANONICAL below AND both the
 * server schema and the client check — that's the point: the change is forced to
 * be made in lockstep.
 */

// jest for the server package runs with cwd = <repo>/server, so the repo root
// is one level up. (ESM test context — no __dirname available.)
const REPO_ROOT = path.resolve(process.cwd(), '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const CANONICAL = {
  usernameMin: 3,
  usernameMax: 20,
  usernameRegex: '/^[a-z0-9_.]+$/',
  passwordMin: 8,
};

describe('validation parity (frontend ↔ backend)', () => {
  describe('username', () => {
    const serverAuth = read('server/src/routes/auth.ts');
    // Client username validation is centralized in validateUsername()
    // (utils/formUtils.ts) — screens delegate to it rather than inlining checks,
    // so the canonical constraints are pinned there and the screen is pinned to
    // the delegation (parity chain: screen → formUtils ↔ server Zod).
    const clientFormUtils = read('utils/formUtils.ts');
    const clientEdit = read('app/settings/edit-username.tsx');

    it('server Zod enforces min/max/regex', () => {
      expect(serverAuth).toContain(`.min(${CANONICAL.usernameMin})`);
      expect(serverAuth).toContain(`.max(${CANONICAL.usernameMax})`);
      expect(serverAuth).toContain(CANONICAL.usernameRegex);
    });

    it('client validateUsername enforces the same min/max/regex', () => {
      expect(clientFormUtils).toMatch(new RegExp(`length\\s*<\\s*${CANONICAL.usernameMin}`));
      expect(clientFormUtils).toMatch(new RegExp(`length\\s*>\\s*${CANONICAL.usernameMax}`));
      expect(clientFormUtils).toContain(`USERNAME_REGEX = ${CANONICAL.usernameRegex}`);
    });

    it('edit-username screen delegates to the shared validator', () => {
      expect(clientEdit).toMatch(
        /import\s*\{[^}]*\bvalidateUsername\b[^}]*\}\s*from\s*'@\/utils\/formUtils'/
      );
      expect(clientEdit).toMatch(/validateUsername\(/);
    });
  });

  describe('password', () => {
    // Password validation was extracted out of the route file into a shared
    // passwordRequirement (server/src/validators/authSchemas.ts), reused by
    // register/reset/change — the canonical constraint now lives there, not
    // inline in auth.ts.
    const serverPasswordSchema = read('server/src/validators/authSchemas.ts');

    it('server Zod enforces min length + letter & number', () => {
      expect(serverPasswordSchema).toContain(`.min(${CANONICAL.passwordMin})`);
      expect(serverPasswordSchema).toContain('/[a-zA-Z]/.test(val)');
      expect(serverPasswordSchema).toContain('/[0-9]/.test(val)');
    });

    it('client enforces the same min length', () => {
      const clientReset = read('app/forgot-password.tsx');
      expect(clientReset).toMatch(new RegExp(`password\\.length\\s*<\\s*${CANONICAL.passwordMin}`));
    });
  });
});
