// ============================================================
// Organizations admin: list + search, typeahead JSON, and the opt-in backfill
// that turns contact `position.organization_name` text into linked
// `organization` pages.
//
// `organization` is the generic company record other plugins extend with
// their own side-car types (procurement's `supplier_profile` points at it).
// Links run both ways: `organization.people[]` points at contacts (with a
// role), and each contact `position[]` may point back at its organization.
// ============================================================

import {
  CmsClient,
  PLUGIN_ID,
  items,
  localized,
  organizationNameKey,
  organizationPeople,
  organizationRow,
  pointer,
  type CmsPage,
} from './cms';
import { adminView } from '@lionrockjs/worker-cms-plugin';

const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
const LIST_LIMIT = 200;
const READ_PAGE = 500;
const WRITE_CHUNK = 100;
/** Page writes (creates + updates) per backfill pass, well under the
 *  subrequest budget: ≤ 5 chunked calls per kind plus the paged reads. */
const BACKFILL_WRITES_PER_PASS = 300;

export async function organizationsIndex(cms: CmsClient, views: Fetcher, url: URL, jsonOnly = false): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const { pages, total } = await cms.list('organization', { q: q || undefined, limit: LIST_LIMIT, offset });
  const rows = pages.map((page) => organizationRow(page));
  const href = (extra: Record<string, string>): string => {
    const search = new URLSearchParams(q ? { q } : {});
    for (const [key, value] of Object.entries(extra)) search.set(key, value);
    const encoded = search.toString();
    return `${ADMIN_BASE}/organizations${encoded ? `?${encoded}` : ''}`;
  };

  return adminView(views, 'Organizations', 'organizations', {
    q,
    rows,
    total,
    count: rows.length,
    offset,
    hasPrev: offset > 0,
    hasNext: offset + rows.length < total,
    prevHref: href({ offset: String(Math.max(0, offset - LIST_LIMIT)) }),
    nextHref: href({ offset: String(offset + LIST_LIMIT) }),
    searchAction: `${ADMIN_BASE}/organizations`,
    createHref: '/admin/pages/new?page_type=organization',
    backfillHref: `${ADMIN_BASE}/organizations/backfill`,
  }, jsonOnly);
}

/** `GET organizations/search.json?q=` — typeahead for this and other plugins' admins. */
export async function organizationsSearchJson(cms: CmsClient, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return Response.json({ organizations: [] });
  const { pages } = await cms.list('organization', { q, limit: 20 });
  return Response.json({
    organizations: pages.map((page) => {
      const row = organizationRow(page);
      return { id: row.id, name: row.name, legalName: row.legalName, website: row.website };
    }),
  });
}

// ── Backfill: contact positions → organization pages ───────────────────────────

interface PositionLink {
  contactId: number;
  positionIndex: number;
  key: string;
  name: string;
  role: string;
}

export interface BackfillPlan {
  /** Positions with an organization name but no organization pointer. */
  links: PositionLink[];
  /** Distinct name keys with no organization yet, mapped to a display name. */
  missing: Map<string, string>;
  /** Organizations by name key (existing ones only). */
  existing: Map<string, CmsPage>;
  contacts: Map<number, CmsPage>;
}

async function listAll(cms: CmsClient, pageType: string): Promise<CmsPage[]> {
  const all: CmsPage[] = [];
  for (let offset = 0; ; offset += READ_PAGE) {
    const { pages, total } = await cms.list(pageType, { limit: READ_PAGE, offset });
    all.push(...pages);
    if (pages.length === 0 || offset + pages.length >= total) return all;
  }
}

/** Classifies current CMS state. Idempotent: linked positions drop out. */
export async function planBackfill(cms: CmsClient): Promise<BackfillPlan> {
  const [contactPages, organizationPages] = await Promise.all([
    listAll(cms, 'contact'),
    listAll(cms, 'organization'),
  ]);
  const existing = new Map<string, CmsPage>();
  for (const page of organizationPages) {
    for (const name of [localized(page.lect, 'name'), page.name, String(page.lect.legal_name ?? '')]) {
      const key = organizationNameKey(name);
      if (key && !existing.has(key)) existing.set(key, page);
    }
  }

  const links: PositionLink[] = [];
  const missing = new Map<string, string>();
  const contacts = new Map<number, CmsPage>();
  for (const page of contactPages) {
    items(page.lect, 'position').forEach((position, positionIndex) => {
      if (pointer(position, 'organization')) return;
      const name = localized(position, 'organization_name').trim();
      const key = organizationNameKey(name);
      if (!key) return;
      contacts.set(page.id, page);
      links.push({ contactId: page.id, positionIndex, key, name, role: localized(position, 'title').trim() });
      if (!existing.has(key) && !missing.has(key)) missing.set(key, name);
    });
  }
  return { links, missing, existing, contacts };
}

export async function backfillPreview(cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
  const plan = await planBackfill(cms);
  return adminView(views, 'Organizations', 'organization-backfill', backfillView(plan, null), jsonOnly);
}

/**
 * One bounded pass: create missing organizations (with their people), add
 * newly linked people to existing organizations, then point contact positions
 * at their organization. Each step is rediscovered from CMS state on the next
 * pass, so an interrupted pass never duplicates an organization.
 */
export async function backfillPass(cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
  const plan = await planBackfill(cms);
  let budget = BACKFILL_WRITES_PER_PASS;
  // Contacts each organization's people list is known to hold after steps 1–2.
  // Step 3 links only those, so a position never points at an organization
  // that does not list the contact back.
  const ensured = new Map<number, Set<string>>();
  const ensure = (organizationId: number, people: Array<{ _pointers: { contact: string } }>): void => {
    ensured.set(organizationId, new Set(people.map((person) => person._pointers.contact)));
  };

  // 1. Create missing organizations, people included.
  const toCreate = [...plan.missing].slice(0, budget);
  const created = new Map<string, CmsPage>();
  for (let index = 0; index < toCreate.length; index += WRITE_CHUNK) {
    const chunk = toCreate.slice(index, index + WRITE_CHUNK);
    const result = await cms.batchCreate(chunk.map(([key, name]) => ({
      page_type: 'organization',
      name,
      lect: { name: { en: name }, people: peopleFor(plan, new Set([key]), []) },
    })));
    for (const page of result.created) {
      const key = organizationNameKey(page.name);
      created.set(key, page);
      ensure(page.id, peopleFor(plan, new Set([key]), []));
    }
  }
  budget -= created.size;

  // 2. Existing organizations gain the contacts not yet in their people list.
  //    One organization may be reachable by several keys (name, legal name).
  const keysByOrganization = new Map<number, { page: CmsPage; keys: Set<string> }>();
  for (const [key, page] of plan.existing) {
    const entry = keysByOrganization.get(page.id) ?? { page, keys: new Set<string>() };
    entry.keys.add(key);
    keysByOrganization.set(page.id, entry);
  }
  const peopleUpdates: Array<{ id: number; lect: Record<string, unknown> }> = [];
  for (const { page, keys } of keysByOrganization.values()) {
    const current = organizationPeople(page.lect);
    const next = peopleFor(plan, keys, current);
    if (next.length === current.length) {
      ensure(page.id, next);
    } else if (peopleUpdates.length < budget) {
      peopleUpdates.push({ id: page.id, lect: { people: next } });
      ensure(page.id, next);
    }
  }
  for (let index = 0; index < peopleUpdates.length; index += WRITE_CHUNK) {
    await cms.batchUpdate(peopleUpdates.slice(index, index + WRITE_CHUNK));
  }
  budget -= peopleUpdates.length;

  // 3. Point each contact's positions at an organization that now lists it.
  const organizationFor = (key: string): CmsPage | undefined => plan.existing.get(key) ?? created.get(key);
  const contactUpdates: Array<{ id: number; lect: Record<string, unknown> }> = [];
  for (const [contactId, page] of plan.contacts) {
    if (contactUpdates.length >= budget) break;
    const positions = items(page.lect, 'position').map((position) => ({ ...position }));
    let changed = false;
    for (const link of plan.links) {
      if (link.contactId !== contactId) continue;
      const organization = organizationFor(link.key);
      if (!organization || !ensured.get(organization.id)?.has(String(contactId))) continue;
      const position = positions[link.positionIndex];
      const pointers = position._pointers && typeof position._pointers === 'object'
        ? position._pointers as Record<string, unknown>
        : {};
      position._pointers = { ...pointers, organization: String(organization.id) };
      changed = true;
    }
    if (changed) contactUpdates.push({ id: contactId, lect: { position: positions } });
  }
  for (let index = 0; index < contactUpdates.length; index += WRITE_CHUNK) {
    await cms.batchUpdate(contactUpdates.slice(index, index + WRITE_CHUNK));
  }

  const after = await planBackfill(cms);
  const wrote = created.size + peopleUpdates.length + contactUpdates.length;
  return adminView(views, 'Organizations', 'organization-backfill', backfillView(after, {
    created: created.size,
    peopleUpdated: peopleUpdates.length,
    contactsLinked: contactUpdates.length,
    wrote,
  }), jsonOnly);
}

/** People for an organization: the current list plus every contact linked by name, once each. */
function peopleFor(
  plan: BackfillPlan,
  keys: Set<string>,
  current: Array<{ contactId: string; role: string }>,
): Array<{ role: string; _pointers: { contact: string } }> {
  const seen = new Set(current.map((person) => person.contactId));
  const people = current.map((person) => ({ role: person.role, _pointers: { contact: person.contactId } }));
  for (const link of plan.links) {
    const contactId = String(link.contactId);
    if (!keys.has(link.key) || seen.has(contactId)) continue;
    seen.add(contactId);
    people.push({ role: link.role, _pointers: { contact: contactId } });
  }
  return people;
}

function backfillView(
  plan: BackfillPlan,
  pass: { created: number; peopleUpdated: number; contactsLinked: number; wrote: number } | null,
): Record<string, unknown> {
  const remaining = plan.links.length;
  return {
    backHref: `${ADMIN_BASE}/organizations`,
    action: `${ADMIN_BASE}/organizations/backfill`,
    positions: remaining,
    contacts: plan.contacts.size,
    toCreate: plan.missing.size,
    toLink: remaining - [...plan.links].filter((link) => plan.missing.has(link.key)).length,
    samples: [...plan.missing.values()].slice(0, 20),
    hasPass: pass !== null,
    pass,
    done: remaining === 0,
    // A pass that wrote nothing while work remains needs a human, not a loop.
    stuck: pass !== null && pass.wrote === 0 && remaining > 0,
  };
}
