import { attr, items, localized } from './cms';

export interface ContactEmailOption { email: string; label: string; source: string }
const key = (value: string): string => value.trim().toLowerCase();

/** Eligible eDM addresses, in fallback order. Spouse addresses are never recipients. */
export function contactEmailOptions(lect: Record<string, unknown>): ContactEmailOption[] {
  const options: ContactEmailOption[] = [];
  const seen = new Set<string>();
  const add = (email: string, source: string, label: string): void => {
    const value = email.trim();
    if (!value || key(value) === 'undefined' || seen.has(key(value))) return;
    seen.add(key(value));
    options.push({ email: value, source, label });
  };
  for (const row of items(lect, 'email')) add(attr(row, 'email'), 'personal', 'Personal');
  for (const row of items(lect, 'position')) add(attr(row, 'email'), 'work', localized(row, 'organization_name') || 'Work');
  for (const row of items(lect, 'position')) add(attr(row, 'general_email'), 'general', `General – ${localized(row, 'organization_name') || 'Work'}`);
  for (const row of items(lect, 'assistant')) add(attr(row, 'email'), 'assistant', `Assistant – ${localized(row, 'name') || 'Assistant'}`);
  return options;
}

/** Ignore stale selections and fall back to personal, work, general, then assistant. */
export function primaryEdmEmail(lect: Record<string, unknown>): string {
  const options = contactEmailOptions(lect);
  const selected = key(attr(lect, 'primary_email'));
  return options.find(option => key(option.email) === selected)?.email || options[0]?.email || '';
}

/** Assistants only; never CC the recipient twice, or include a spouse. */
export function assistantCcEmails(lect: Record<string, unknown>, recipient = primaryEdmEmail(lect)): string[] {
  const seen = new Set([key(recipient)]);
  return items(lect, 'assistant').map(row => attr(row, 'email').trim()).filter(email => {
    const normalized = key(email);
    if (!normalized || normalized === 'undefined' || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
