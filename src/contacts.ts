// ============================================================
// Contacts admin: list + search, CSV export (+ sample), duplicate check and
// the typeahead JSON other plugin admins consume (the legacy HX equivalent).
// Authoring stays in the CMS page editor — rows link there.
//
// Ported from the legacy controller/admin/Contact.mjs list/search/export
// surface. Search rides the Plugin API `q` (name/slug/lect LIKE per term), so it
// covers names, emails, organizations and phone digits without a bespoke
// index.
// ============================================================

import { CmsClient, PLUGIN_ID, contactEmails, contactNameKey, contactRow, type CmsPage } from './cms';
import { adminView } from '@lionrockjs/worker-cms-plugin';

export const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
const LIST_LIMIT = 200;
const EXPORT_LIMIT = 500;

export async function contactsIndex(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false, canEdit = false): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const flash = (url.searchParams.get('flash') ?? '').trim();
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const { pages, total } = await cms.list('contact', { q: q || undefined, limit: LIST_LIMIT, offset });
  const rows = pages.map((page) => contactRow(page));

  const params = (extra: Record<string, string>): string => {
    const search = new URLSearchParams();
    if (q) search.set('q', q);
    for (const [key, value] of Object.entries(extra)) search.set(key, value);
    const encoded = search.toString();
    return encoded ? `?${encoded}` : '';
  };

  return adminView(views, 'Contacts', 'contacts', {
    q,
    flash,
    canEdit,
    rows,
    total,
    count: rows.length,
    offset,
    hasPrev: offset > 0,
    hasNext: offset + rows.length < total,
    prevHref: `${ADMIN_BASE}/contacts${params({ offset: String(Math.max(0, offset - LIST_LIMIT)) })}`,
    nextHref: `${ADMIN_BASE}/contacts${params({ offset: String(offset + LIST_LIMIT) })}`,
    searchAction: `${ADMIN_BASE}/contacts`,
    bulkDeleteAction: `${ADMIN_BASE}/contacts/bulk-delete`,
    createHref: `/admin/pages/new?page_type=contact`,
    exportHref: `${ADMIN_BASE}/contacts/export${params({})}`,
    exportSampleHref: `${ADMIN_BASE}/contacts/export-sample`,
    importHref: `${ADMIN_BASE}/contacts/import`,
  }, jsonOnly);
}

// ── Bulk delete ────────────────────────────────────────────────────────────────

/**
 * POST bulk-delete: `ids` (repeated) from the list's checkboxes, plus the
 * current `q` so the redirect lands back on the same search. The host's batch
 * endpoint scopes deletes to this plugin's page types and soft-deletes to
 * trash, so no page_type re-check is needed here.
 */
export async function bulkDeleteContacts(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const q = String(form.get('q') ?? '').trim();
  const ids = [...new Set(form.getAll('ids').map((value) => Number(value)))]
    .filter((id) => Number.isInteger(id) && id > 0);
  const back = (flash: string): Response => {
    const search = new URLSearchParams(q ? { q } : {});
    search.set('flash', flash);
    return redirect(`${ADMIN_BASE}/contacts?${search.toString()}`);
  };
  if (!ids.length) return back('No contacts selected');
  await cms.batchRemove(ids);
  return back(`Deleted ${ids.length} contact${ids.length === 1 ? '' : 's'}`);
}

// ── Export ─────────────────────────────────────────────────────────────────────

/** Columns match the legacy contact export where practical (see import map). */
const EXPORT_COLUMNS = [
  'contact_id', 'source', 'prefix', 'suffix', 'gender', 'countryregion', 'nationality',
  'first_name', 'last_name', 'full_name', 'chinese_name_tc', 'chinese_name_sc',
  'company_1', 'title_1', 'department_1', 'email_work_1', 'work_phone_1_direct',
  'mobile_1', 'email_personal_1', 'home_address_1', 'remarks_contact', 'email_status',
];

export async function exportContacts(cms: CmsClient, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const lines: string[] = [EXPORT_COLUMNS.map(csvValue).join(',')];
  // Bounded pagination keeps each Plugin API call light; EXPORT_LIMIT rows per call.
  for (let offset = 0; ; offset += EXPORT_LIMIT) {
    const { pages, total } = await cms.list('contact', { q: q || undefined, limit: EXPORT_LIMIT, offset });
    for (const page of pages) lines.push(exportRow(page).map(csvValue).join(','));
    if (offset + pages.length >= total || pages.length === 0) break;
  }
  return csvResponse(lines.join('\n'), q ? `contacts-search-${Date.now()}.csv` : `contacts-export-${Date.now()}.csv`);
}

export function exportSample(): Response {
  const sample = [
    EXPORT_COLUMNS.map(csvValue).join(','),
    EXPORT_COLUMNS.map((column) => csvValue(sampleValue(column))).join(','),
  ].join('\n');
  return csvResponse(sample, 'contacts-sample.csv');
}

function exportRow(page: CmsPage): string[] {
  const lect = page.lect;
  const row = contactRow(page);
  const attrOf = (key: string): string => String((lect[key] as string | number | undefined) ?? '');
  const loc = (key: string, lang = 'en'): string => {
    const value = lect[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return String((value as Record<string, unknown>)[lang] ?? '');
    return typeof value === 'string' ? value : '';
  };
  const firstPosition = (Array.isArray(lect.position) ? lect.position[0] as Record<string, unknown> : undefined) ?? {};
  const posLoc = (key: string): string => {
    const value = firstPosition[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return String((value as Record<string, unknown>).en ?? '');
    return typeof value === 'string' ? value : '';
  };
  const firstHome = (Array.isArray(lect.home) ? lect.home[0] as Record<string, unknown> : undefined) ?? {};
  const mobile = (Array.isArray(lect.phone) ? lect.phone as Array<Record<string, unknown>> : [])
    .find((entry) => String(entry.type ?? '').toLowerCase() !== 'home');
  const personalEmail = (Array.isArray(lect.email) ? lect.email[0] as Record<string, unknown> : undefined) ?? {};
  return [
    attrOf('id') || String(page.id),
    attrOf('source'),
    attrOf('prefix'),
    attrOf('suffix'),
    attrOf('gender'),
    attrOf('region'),
    attrOf('nationality'),
    loc('first_name'),
    loc('last_name'),
    loc('full_name'),
    loc('full_name', 'zh-hant'),
    loc('full_name', 'zh-hans'),
    row.organization,
    row.title,
    posLoc('department'),
    String(firstPosition.email ?? ''),
    String(firstPosition.direct_phone ?? ''),
    String(mobile?.phone ?? ''),
    String(personalEmail.email ?? ''),
    (() => {
      const value = firstHome.address;
      if (value && typeof value === 'object' && !Array.isArray(value)) return String((value as Record<string, unknown>).en ?? '');
      return typeof value === 'string' ? value : '';
    })(),
    attrOf('remarks'),
    attrOf('email_status'),
  ];
}

function sampleValue(column: string): string {
  const samples: Record<string, string> = {
    contact_id: 'C-1001',
    source: 'website',
    prefix: 'Ms.',
    gender: 'F',
    countryregion: 'Hong Kong',
    first_name: 'Ada',
    last_name: 'Lovelace',
    full_name: 'Ada Lovelace',
    chinese_name_tc: '愛達',
    company_1: 'Analytical Engines Ltd',
    title_1: 'Director',
    email_work_1: 'ada@example.com',
    work_phone_1_direct: '+852 1234 5678',
    mobile_1: '+852 9876 5432',
    email_personal_1: 'ada@personal.example',
    remarks_contact: 'VIP',
  };
  return samples[column] ?? '';
}

// ── Duplicate check ────────────────────────────────────────────────────────────

/**
 * `GET check-duplicate.json?email=&name=` — matches by any of the contact's
 * emails first, then by display name (legacy check_duplicate semantics).
 */
export async function checkDuplicate(cms: CmsClient, url: URL): Promise<Response> {
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const name = (url.searchParams.get('name') ?? '').trim().toLowerCase();
  if (!email && !name) return Response.json({ duplicates: [] });

  const matches = new Map<number, CmsPage>();
  if (email) {
    const { pages } = await cms.list('contact', { q: email, limit: 50 });
    for (const page of pages) {
      if (contactEmails(page.lect).includes(email)) matches.set(page.id, page);
    }
  }
  if (name) {
    const { pages } = await cms.list('contact', { q: name, limit: 50 });
    for (const page of pages) {
      if (contactNameKey(page) === name) matches.set(page.id, page);
    }
  }
  return Response.json({
    duplicates: [...matches.values()].map((page) => {
      const row = contactRow(page);
      return { id: row.id, name: row.name, email: row.email, organization: row.organization };
    }),
  });
}

// ── Typeahead JSON (legacy HX contacts-search equivalent) ──────────────────────

/**
 * `GET search.json?q=` — consumed cross-plugin from the browser (same-origin
 * admin proxy), e.g. by the events plugin's add-from-contacts page.
 */
export async function searchJson(cms: CmsClient, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return Response.json({ contacts: [] });
  const { pages } = await cms.list('contact', { q, limit: 20 });
  return Response.json({
    contacts: pages.map((page) => {
      const row = contactRow(page);
      return { id: row.id, name: row.name, email: row.email, organization: row.organization, title: row.title };
    }),
  });
}

// ── Shared ─────────────────────────────────────────────────────────────────────

export function csvValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
