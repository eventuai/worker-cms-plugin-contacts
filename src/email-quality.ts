// ============================================================
// Email Quality — ported from the legacy controller/admin/EmailQuality.mjs:
// search an email's verification status, list contacts whose emails are
// unverified, submit a batch to an external verifier, and set a status by
// hand. Status lives on the contact page as the `email_status` attr (values:
// verified / unverified / risky / invalid / pending), written over F1.
//
// The external verifier is generic: POST {emails:[…]} to VERIFIER_API_URL with
// a bearer VERIFIER_API_KEY, expecting [{email, status}] back. Without both
// vars the submit action explains what to configure instead of failing
// silently. A syntax-level heuristic (same one the events plugin uses for its
// good/risky split) is always shown alongside as a hint.
// ============================================================

import { CmsClient, attr, contactEmails, contactRow, type CmsPage } from './cms';
import { ADMIN_BASE } from './contacts';
import { adminView } from '@lionrockjs/worker-cms-plugin';

export interface VerifierEnv {
  VERIFIER_API_URL?: string;
  VERIFIER_API_KEY?: string;
}

const STATUSES = ['verified', 'unverified', 'risky', 'invalid', 'pending'] as const;
const SCAN_LIMIT = 500;

export async function emailQualityIndex(
  cms: CmsClient,
  views: Fetcher,
  env: VerifierEnv,
  url: URL,
  jsonOnly = false,
): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const flash = (url.searchParams.get('flash') ?? '').trim();

  const contacts = await scanContacts(cms, q || undefined);
  const counts: Record<string, number> = { none: 0 };
  for (const status of STATUSES) counts[status] = 0;

  const rows: Array<Record<string, unknown>> = [];
  for (const page of contacts) {
    const emails = contactEmails(page.lect);
    if (!emails.length) continue;
    const status = attr(page.lect, 'email_status') || '';
    counts[status || 'none'] = (counts[status || 'none'] ?? 0) + 1;
    // Search mode: only contacts carrying the searched email.
    if (q && !emails.some((email) => email.includes(q))) continue;
    const row = contactRow(page);
    rows.push({
      id: row.id,
      name: row.name,
      organization: row.organization,
      emails: emails.join(', '),
      status,
      hasStatus: status !== '',
      heuristic: emailHeuristic(emails[0]),
      editHref: row.editHref,
      statusAction: `${ADMIN_BASE}/email-quality/status`,
      statuses: STATUSES.map((value) => ({ value, selected: value === status })),
    });
  }

  const unverified = q ? rows : rows.filter((row) => !row.hasStatus || row.status === 'unverified');

  return adminView(views, 'Email Quality', 'email-quality', {
    q,
    flash,
    searchAction: `${ADMIN_BASE}/email-quality`,
    submitAction: `${ADMIN_BASE}/email-quality/submit`,
    verifierConfigured: Boolean(env.VERIFIER_API_URL && env.VERIFIER_API_KEY),
    counts: [
      { label: 'Verified', value: counts.verified },
      { label: 'Unverified', value: counts.unverified + counts.none },
      { label: 'Risky', value: counts.risky },
      { label: 'Invalid', value: counts.invalid },
      { label: 'Pending', value: counts.pending },
    ],
    rows: q ? rows : unverified.slice(0, 100),
    rowCount: (q ? rows : unverified).length,
    isSearch: Boolean(q),
  }, jsonOnly);
}

/** POST status: manual per-contact override — {contact_id, status}. */
export async function setEmailStatus(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const contactId = Number(form.get('contact_id'));
  const status = String(form.get('status') ?? '').trim().toLowerCase();
  if (!Number.isInteger(contactId) || contactId <= 0 || !STATUSES.includes(status as typeof STATUSES[number])) {
    return new Response('bad request', { status: 400 });
  }
  const page = await cms.get(contactId);
  if (page.page_type !== 'contact') return new Response('not found', { status: 404 });
  await cms.update(contactId, { lect: { email_status: status } });
  return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent('Status updated')}`);
}

/**
 * POST submit: sends every unverified contact's primary email to the external
 * verifier and writes the returned statuses back (marks `pending` when the
 * verifier answers asynchronously / omits an address).
 */
export async function submitToVerifier(cms: CmsClient, env: VerifierEnv): Promise<Response> {
  if (!env.VERIFIER_API_URL || !env.VERIFIER_API_KEY) {
    return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent(
      'Configure VERIFIER_API_URL and VERIFIER_API_KEY (wrangler secret put) to enable verification',
    )}`);
  }

  const contacts = await scanContacts(cms);
  const targets = contacts
    .map((page) => ({ page, email: contactEmails(page.lect)[0] ?? '' }))
    .filter(({ page, email }) => email && !attr(page.lect, 'email_status'));
  if (!targets.length) return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent('Nothing to verify')}`);

  const response = await fetch(env.VERIFIER_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.VERIFIER_API_KEY}`,
    },
    body: JSON.stringify({ emails: targets.map(({ email }) => email) }),
  });
  if (!response.ok) {
    return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent(`Verifier error ${response.status}`)}`);
  }
  const results = await response.json().catch(() => []) as Array<{ email?: string; status?: string }>;
  const byEmail = new Map<string, string>();
  for (const entry of Array.isArray(results) ? results : []) {
    const email = String(entry.email ?? '').toLowerCase();
    const status = String(entry.status ?? '').toLowerCase();
    if (email && STATUSES.includes(status as typeof STATUSES[number])) byEmail.set(email, status);
  }

  let written = 0;
  for (const { page, email } of targets) {
    await cms.update(page.id, { lect: { email_status: byEmail.get(email) ?? 'pending' } });
    written += 1;
  }
  return redirect(`${ADMIN_BASE}/email-quality?flash=${encodeURIComponent(`Submitted ${written} email(s) to the verifier`)}`);
}

// ── Shared ─────────────────────────────────────────────────────────────────────

async function scanContacts(cms: CmsClient, q?: string): Promise<CmsPage[]> {
  const all: CmsPage[] = [];
  for (let offset = 0; ; offset += SCAN_LIMIT) {
    const { pages, total } = await cms.list('contact', { q, limit: SCAN_LIMIT, offset });
    all.push(...pages);
    if (offset + pages.length >= total || pages.length === 0) break;
  }
  return all;
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
