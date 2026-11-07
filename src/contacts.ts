// ============================================================
// Contacts admin: list + search, bulk delete, duplicate check and
// the typeahead JSON other plugin admins consume (the legacy HX equivalent).
// Authoring stays in the CMS page editor — rows link there.
//
// Ported from the legacy controller/admin/Contact.mjs list/search surface.
// CSV import/export is handled by the generic import-export plugin. Search
// rides the Plugin API `q` (name/slug/lect LIKE per term), so it
// covers names, emails, organizations and phone digits without a bespoke
// index.
// ============================================================

import { CmsClient, PLUGIN_ID, contactEmails, contactNameKey, contactRow, type CmsPage } from './cms';
import type { ContactsAccess } from './permissions';
import { adminView } from '@lionrockjs/worker-cms-plugin';

export const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
const LIST_LIMIT = 200;

export async function contactsIndex(cms: CmsClient, views: Fetcher, url: URL, access: ContactsAccess, jsonOnly = false): Promise<Response> {
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
    canCreate: access.canCreate,
    canUpdate: access.canUpdate,
    canDelete: access.canDelete,
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

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
