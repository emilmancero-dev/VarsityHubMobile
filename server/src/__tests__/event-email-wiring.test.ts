import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const eventsSrc = readFileSync(join(process.cwd(), 'src', 'routes', 'events.ts'), 'utf8');

describe('event email wiring', () => {
  it('does NOT send a confirmation email from the live "watching" (RSVP) route — owner rule 2026-09-14: "No email for now"', () => {
    expect(eventsSrc).not.toMatch(/sendEventRsvpConfirmedEmail/);
  });

  it('sends a submission receipt email from the live create route', () => {
    expect(eventsSrc).toMatch(
      /eventsRouter\.post\(\s*'\/'[\s\S]*?sendEventSubmissionReceivedEmail\(\{/
    );
  });

  it('sends attendee update emails from the live patch route', () => {
    expect(eventsSrc).toMatch(/eventsRouter\.patch\(\s*'\/:id'[\s\S]*?sendEventUpdatedEmail\(\{/);
  });
});
