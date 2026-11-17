import { describe, it, expect } from 'vitest';
import { contactEmailOptions, primaryEdmEmail, assistantCcEmails } from '../src/contact-email';

const lect = {
  primary_email: ' WORK@EXAMPLE.COM ',
  email: [{ email: 'personal@example.com' }],
  position: [{ email: 'work@example.com', general_email: 'general@example.com', organization_name: { en: 'Company' } }],
  assistant: [{ email: 'pa@example.com' }, { email: 'PA@EXAMPLE.COM' }, { email: 'work@example.com' }],
  spouse: [{ email: 'spouse@example.com' }],
};
describe('eDM contact recipient rules', () => {
  it('uses a selected eligible email case-insensitively, with deduplicated options and no spouse', () => {
    expect(primaryEdmEmail(lect)).toBe('work@example.com');
    expect(contactEmailOptions(lect).map(option => option.email)).toEqual(['personal@example.com', 'work@example.com', 'general@example.com', 'pa@example.com']);
    expect(assistantCcEmails(lect)).toEqual(['pa@example.com']);
  });
  it('falls back after an address is removed and supports assistant-only contacts', () => {
    expect(primaryEdmEmail({ ...lect, primary_email: 'gone@example.com' })).toBe('personal@example.com');
    expect(primaryEdmEmail({ ...lect, primary_email: 'spouse@example.com' })).toBe('personal@example.com');
    const assistants = { assistant: [{ email: 'pa@example.com' }, { email: 'second@example.com' }] };
    expect(primaryEdmEmail(assistants)).toBe('pa@example.com');
    expect(assistantCcEmails(assistants)).toEqual(['second@example.com']);
    expect(primaryEdmEmail({})).toBe('');
  });
});
