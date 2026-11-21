import { readEmailQuality, qualityEmail, qualityStatus, type QualityInput } from './email-quality-records';
import { saveQuality } from './quality-import';
import { primaryEdmEmail } from './contact-email';
// Email quality is stored per normalized address in private email_quality pages.
// Legacy contact-wide overrides remain a fallback for the effective primary address.

import { CmsClient, attr, contactEmails, contactRow } from './cms';
import { ADMIN_BASE } from './contacts';
import { adminView } from '@lionrockjs/worker-cms-plugin';

export interface VerifierEnv {
  VERIFIER_API_URL?: string;
  VERIFIER_API_KEY?: string;
}

const STATUSES = ['verified', 'unverified', 'risky', 'invalid', 'pending'] as const;

export async function emailQualityIndex(
  cms: CmsClient,
  views: Fetcher,
  env: VerifierEnv,
  url: URL,
  jsonOnly = false,
  canUpdate = true,
): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const flash = (url.searchParams.get('flash') ?? '').trim();

  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const { pages: contacts, total } = await cms.list('contact', { q: q || undefined, limit: 100, offset });
  const records = await readEmailQuality(cms, [...contacts.flatMap(page => contactEmails(page.lect)), ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) ? [q] : [])]);
  const rows: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {};
  for (const page of contacts) {
    for (const email of contactEmails(page.lect)) {
      if (q && !email.includes(q)) continue;
      const record = records.get(email);
      const status = record ? qualityStatus(record.lect) : email === qualityEmail(primaryEdmEmail(page.lect)) ? attr(page.lect, 'email_status') : '';
      counts[status || 'unverified'] = (counts[status || 'unverified'] || 0) + 1;
      const row = contactRow(page);
      rows.push({ id: page.id, name: row.name, organization: row.organization, emails: email, email, status,
        result: record?.lect.result || '', score: record?.lect.quality ?? '', free: record?.lect.free || '', source: record?.lect.source || '',
        hasStatus: !!status, heuristic: emailHeuristic(email), editHref: row.editHref,
        statusAction: `${ADMIN_BASE}/email-quality/status`, statuses: STATUSES.map(value => ({ value, selected: value === status })),
      });
    }
  }
  const standalone = records.get(q);
  if (q && standalone && !rows.some(row => row.email === q)) rows.push({ id: '', name: 'Imported address', emails: q, email: q, status: qualityStatus(standalone.lect), hasStatus: true, result: standalone.lect.result || '', score: standalone.lect.quality ?? '', free: standalone.lect.free || '', source: standalone.lect.source || '', heuristic: emailHeuristic(q) });
  const unverified = rows.filter(row => !row.hasStatus || row.status === 'unverified');
  const pageHref = (start: number) => `${ADMIN_BASE}/email-quality?${new URLSearchParams({ q, offset: String(start) })}`;
  return adminView(views, 'Email Quality', 'email-quality', {
    q, flash, canUpdate, searchAction: `${ADMIN_BASE}/email-quality`, submitAction: `${ADMIN_BASE}/email-quality/submit?offset=${offset}`,
    importHref: `${ADMIN_BASE}/email-quality/import`, verifierConfigured: Boolean(env.VERIFIER_API_URL && env.VERIFIER_API_KEY),
    counts: STATUSES.map(status => ({ label: status, value: counts[status] || 0 })),
    rows: q ? rows : unverified, rowCount: (q ? rows : unverified).length, isSearch: !!q,
    previousHref: offset > 0 ? pageHref(Math.max(0, offset - 100)) : '', nextHref: offset + contacts.length < total ? pageHref(offset + 100) : '',
  }, jsonOnly);
}

/** Manual per-address override; requests without email retain the legacy contact-wide API. */
export async function setEmailStatus(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const contactId = Number(form.get('contact_id'));
  const status = String(form.get('status') ?? '').trim().toLowerCase();
  if (!Number.isInteger(contactId) || contactId <= 0 || !STATUSES.includes(status as typeof STATUSES[number])) {
    return new Response('bad request', { status: 400 });
  }
  const page = await cms.get(contactId);
  if (page.page_type !== 'contact') return new Response('not found', { status: 404 });
  const email = qualityEmail(form.get('email'));
  if (email) {
    if (!contactEmails(page.lect).includes(email)) return new Response('Email does not belong to this contact.', { status: 400 });
    const existing = (await readEmailQuality(cms, [email], false)).get(email);
    await saveQuality(cms, { email, status, quality: status === 'verified' ? '100' : status === 'invalid' ? '0' : status === 'risky' ? '50' : '', source: 'manual', contact_id: String(contactId) }, existing);
  } else {
    // Compatibility for older integrations using the contact-wide override endpoint.
    await cms.update(contactId, { lect: { email_status: status } });
  }
  return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent('Status updated')}`);
}

/** Verify at most 20 distinct unverified addresses on the current 100-contact page. */
export async function submitToVerifier(cms: CmsClient, env: VerifierEnv, offset = 0): Promise<Response> {
  if (!env.VERIFIER_API_URL || !env.VERIFIER_API_KEY) {
    return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent(
      'Configure VERIFIER_API_URL and VERIFIER_API_KEY (wrangler secret put) to enable verification',
    )}`);
  }

  const { pages: contacts } = await cms.list('contact', { limit: 100, offset });
  const inventory = [...new Set(contacts.flatMap(page => contactEmails(page.lect)))];
  const records = await readEmailQuality(cms, inventory, false);
  const legacyVerified = new Set(contacts.filter(page => ['verified', 'invalid', 'risky', 'pending'].includes(attr(page.lect, 'email_status'))).map(page => qualityEmail(primaryEdmEmail(page.lect))));
  const targets = inventory.filter(email => records.has(email) ? qualityStatus(records.get(email)!.lect) === 'unverified' : !legacyVerified.has(email)).slice(0, 20);
  if (!targets.length) return redirect(`${ADMIN_BASE}/email-quality?offset=${offset}&flash=Nothing+to+verify+on+this+contact+page`);

  const response = await fetch(env.VERIFIER_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.VERIFIER_API_KEY}`,
    },
    body: JSON.stringify({ emails: targets }),
  });
  if (!response.ok) {
    return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent(`Verifier error ${response.status}`)}`);
  }
  const results = await response.json().catch(() => []) as Array<{ email?: string; status?: string }>;
  const byEmail = new Map<string, string>();
  for (const entry of Array.isArray(results) ? results : []) {
    const email = qualityEmail(entry.email); const status = String(entry.status || '').toLowerCase();
    if (targets.includes(email) && STATUSES.includes(status as typeof STATUSES[number])) byEmail.set(email, status);
  }
  for (const email of targets) {
    const status = byEmail.get(email) || 'pending';
    const row: QualityInput = { email, status, quality: status === 'verified' ? '100' : status === 'invalid' ? '0' : status === 'risky' ? '50' : '', source: 'verifier' };
    await saveQuality(cms, row, records.get(email));
  }
  return redirect(`${ADMIN_BASE}/email-quality?offset=${offset}&flash=${encodeURIComponent(`Submitted ${targets.length} address(es). Repeat for remaining addresses on this contact page.`)}`);
}


/** Same syntax-level split the events plugin uses for auto-send (not real verification). */
export function emailHeuristic(email: string): 'good' | 'risky' | 'invalid' {
  const value = (email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) return 'invalid';
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain.includes('.')) return 'risky';
  if (local.includes('+')) return 'risky';
  if (['info', 'admin', 'sales', 'contact', 'hello', 'support', 'office', 'noreply', 'no-reply'].includes(local)) return 'risky';
  return 'good';
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
