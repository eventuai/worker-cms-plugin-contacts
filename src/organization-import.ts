// ============================================================
// Organization CSV export + import, mirroring the contact import's two-step
// preview → confirm flow (see import.ts):
//
//  - GET  /organizations/export          → CSV of every (or the searched) organization
//  - GET  /organizations/export-sample   → header + one example row
//  - POST /organizations/import          → parse + classify, NO writes (preview)
//  - POST /organizations/import/confirm  → re-parse + re-classify server-side, apply
//
// Export and import share one column set, so an exported file re-imports as
// all-unchanged. Rows match an existing organization by `organization_id`
// (the CMS page id) → registration no. → tax ID → name / legal-name key, each
// existing organization consumed once. `people` links are not part of the CSV
// and are never touched by an import.
// ============================================================

import { CmsClient, attr, items, localized, organizationNameKey, type CmsPage } from './cms';
import { ADMIN_BASE, csvResponse, csvValue } from './contacts';
import { deArmor, diffIncoming, en, parseCsv, readUpload, redirect, toLect, type IncomingFields } from './import';
import { listAll } from './organizations';
import { forbidden, importModeAllowed, importModes, type ContactsAccess } from './permissions';
import { adminView } from '@lionrockjs/worker-cms-plugin';

const CREATE_CHUNK = 25;
const UPDATE_CHUNK = 100;
const EXPORT_LIMIT = 500;
const ADDRESS_COLUMNS = 3;

const ATTR_COLUMNS = ['legal_name', 'registration_no', 'tax_id', 'website', 'general_email', 'general_phone', 'remarks'];

export const ORGANIZATION_COLUMNS = [
  'organization_id', 'name', 'name_zh_hant', 'name_zh_hans',
  ...ATTR_COLUMNS,
  'description',
  ...Array.from({ length: ADDRESS_COLUMNS }, (_, index) => [`address_${index + 1}_type`, `address_${index + 1}`]).flat(),
];

// ── Export ─────────────────────────────────────────────────────────────────────

export async function exportOrganizations(cms: CmsClient, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const lines: string[] = [ORGANIZATION_COLUMNS.map(csvValue).join(',')];
  for (let offset = 0; ; offset += EXPORT_LIMIT) {
    const { pages, total } = await cms.list('organization', { q: q || undefined, limit: EXPORT_LIMIT, offset });
    for (const page of pages) lines.push(exportRow(page).map(csvValue).join(','));
    if (offset + pages.length >= total || pages.length === 0) break;
  }
  return csvResponse(lines.join('\n'), q ? `organizations-search-${Date.now()}.csv` : `organizations-export-${Date.now()}.csv`);
}

export function exportOrganizationsSample(): Response {
  const sample: Record<string, string> = {
    name: 'Analytical Engines',
    name_zh_hant: '分析機',
    legal_name: 'Analytical Engines Ltd',
    registration_no: '12345678',
    website: 'https://ae.example',
    general_email: 'info@ae.example',
    general_phone: '+852 1234 5678',
    address_1_type: 'office',
    address_1: '1 Example Road, Hong Kong',
  };
  return csvResponse([
    ORGANIZATION_COLUMNS.map(csvValue).join(','),
    ORGANIZATION_COLUMNS.map((column) => csvValue(sample[column] ?? '')).join(','),
  ].join('\n'), 'organizations-sample.csv');
}

function exportRow(page: CmsPage): string[] {
  const lect = page.lect;
  const addresses = items(lect, 'address').filter((entry) => localized(entry, 'address') !== '');
  const record: Record<string, string> = {
    organization_id: String(page.id),
    name: localized(lect, 'name') || page.name,
    name_zh_hant: localized(lect, 'name', 'zh-hant'),
    name_zh_hans: localized(lect, 'name', 'zh-hans'),
    description: localized(lect, 'description'),
  };
  for (const key of ATTR_COLUMNS) record[key] = attr(lect, key);
  addresses.slice(0, ADDRESS_COLUMNS).forEach((entry, index) => {
    record[`address_${index + 1}_type`] = attr(entry, 'type');
    record[`address_${index + 1}`] = localized(entry, 'address');
  });
  return ORGANIZATION_COLUMNS.map((column) => record[column] ?? '');
}

// ── Upload form + preview ──────────────────────────────────────────────────────

interface IncomingOrganization extends IncomingFields {
  /** CMS page id from an exported file's `organization_id` column. */
  pageId: number | null;
  displayName: string;
  nameKeys: string[];
}

function formData(error?: string): Record<string, unknown> {
  return {
    action: `${ADMIN_BASE}/organizations/import`,
    backHref: `${ADMIN_BASE}/organizations`,
    sampleHref: `${ADMIN_BASE}/organizations/export-sample`,
    error,
  };
}

export async function organizationImportForm(views: Fetcher, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Import organizations', 'organization-import', formData(), jsonOnly);
}

export async function previewOrganizationImport(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  access: ContactsAccess,
  jsonOnly = false,
): Promise<Response> {
  const fail = (message: string): Promise<Response> =>
    adminView(views, 'Import organizations', 'organization-import', formData(message), jsonOnly);
  const { text, error } = await readUpload(request);
  if (error) return fail(error);
  const incoming = parseOrganizationCsv(text);
  if (!incoming.length) return fail('No organization rows found in the file.');

  const plan = classifyOrganizations(incoming, await listAll(cms, 'organization'));
  return adminView(views, 'Import organizations — preview', 'organization-import-preview', {
    confirmAction: `${ADMIN_BASE}/organizations/import/confirm`,
    backHref: `${ADMIN_BASE}/organizations/import`,
    raw: text,
    rows: plan.map((row) => ({
      isNew: row.state === 'new',
      isUpdate: row.state === 'update',
      name: row.incoming.displayName,
      legalName: row.incoming.attrs.legal_name ?? '',
      website: row.incoming.attrs.website ?? '',
      changes: row.changes,
      hasChanges: row.changes.length > 0,
    })),
    newCount: plan.filter((row) => row.state === 'new').length,
    updateCount: plan.filter((row) => row.state === 'update').length,
    unchangedCount: plan.filter((row) => row.state === 'unchanged').length,
    modes: importModes(access, 'organizations'),
  }, jsonOnly);
}

// ── Confirm ────────────────────────────────────────────────────────────────────

export async function confirmOrganizationImport(request: Request, cms: CmsClient, access: ContactsAccess): Promise<Response> {
  const form = await request.formData();
  const text = String(form.get('raw') ?? '');
  const mode = String(form.get('mode') ?? 'new_and_update');
  if (!importModeAllowed(access, mode)) return forbidden();
  if (!text.trim()) return redirect(`${ADMIN_BASE}/organizations`);

  const plan = classifyOrganizations(parseOrganizationCsv(text), await listAll(cms, 'organization'));

  const creates = mode === 'update_only' ? [] : plan.filter((row) => row.state === 'new');
  for (let start = 0; start < creates.length; start += CREATE_CHUNK) {
    await cms.batchCreate(creates.slice(start, start + CREATE_CHUNK).map((row) => ({
      page_type: 'organization',
      name: row.incoming.displayName,
      lect: toLect(row.incoming),
    })));
  }

  const updates = mode === 'new_only'
    ? []
    : plan.flatMap((row) => row.state === 'update' && row.existing ? [{ id: row.existing.id, lect: toLect(row.incoming) }] : []);
  for (let start = 0; start < updates.length; start += UPDATE_CHUNK) {
    await cms.batchUpdate(updates.slice(start, start + UPDATE_CHUNK));
  }

  const flash = `Imported ${creates.length} new, updated ${updates.length} organization${updates.length === 1 ? '' : 's'}`;
  return redirect(`${ADMIN_BASE}/organizations?${new URLSearchParams({ flash }).toString()}`);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function parseOrganizationCsv(text: string): IncomingOrganization[] {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.replace(/^﻿/, '').trim().toLowerCase());
  const organizations: IncomingOrganization[] = [];
  for (const cells of rows.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = deArmor((cells[index] ?? '').trim());
    });
    const organization = recordToOrganization(record);
    if (organization) organizations.push(organization);
  }
  return organizations;
}

function recordToOrganization(record: Record<string, string>): IncomingOrganization | null {
  const get = (key: string): string => record[key] ?? '';

  const attrs: Record<string, string> = {};
  for (const key of ATTR_COLUMNS) {
    const value = key === 'general_email' ? get(key).toLowerCase() : get(key);
    if (value) attrs[key] = value;
  }

  const values: Record<string, Record<string, string>> = {};
  const setValue = (field: string, language: string, value: string): void => {
    if (value) values[field] = { ...(values[field] ?? {}), [language]: value };
  };
  setValue('name', 'en', get('name'));
  setValue('name', 'zh-hant', get('name_zh_hant'));
  setValue('name', 'zh-hans', get('name_zh_hans'));
  setValue('description', 'en', get('description'));

  const itemGroups: Record<string, Array<Record<string, unknown>>> = {};
  for (let n = 1; n <= ADDRESS_COLUMNS; n++) {
    const address = get(`address_${n}`);
    if (!address) continue;
    itemGroups.address = [...(itemGroups.address ?? []), { type: get(`address_${n}_type`), address: en(address) }];
  }

  const displayName = values.name?.en || values.name?.['zh-hant'] || values.name?.['zh-hans'] || attrs.legal_name || '';
  if (!displayName) return null;
  const pageId = Number(get('organization_id'));
  return {
    pageId: Number.isInteger(pageId) && pageId > 0 ? pageId : null,
    attrs,
    values,
    itemGroups,
    displayName,
    nameKeys: [values.name?.en ?? '', attrs.legal_name ?? ''].map(organizationNameKey).filter(Boolean),
  };
}

// ── Classification ─────────────────────────────────────────────────────────────

interface PlanRow {
  state: 'new' | 'update' | 'unchanged';
  incoming: IncomingOrganization;
  existing?: CmsPage;
  changes: Array<{ label: string; from: string; to: string }>;
}

function classifyOrganizations(incoming: IncomingOrganization[], existing: CmsPage[]): PlanRow[] {
  const byId = new Map<number, CmsPage>();
  const byAttr = { registration_no: new Map<string, CmsPage[]>(), tax_id: new Map<string, CmsPage[]>() };
  const byName = new Map<string, CmsPage[]>();
  const add = (map: Map<string, CmsPage[]>, key: string, page: CmsPage): void => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(page)) map.set(key, [...list, page]);
  };
  for (const page of existing) {
    byId.set(page.id, page);
    add(byAttr.registration_no, attr(page.lect, 'registration_no').trim().toLowerCase(), page);
    add(byAttr.tax_id, attr(page.lect, 'tax_id').trim().toLowerCase(), page);
    for (const name of [localized(page.lect, 'name'), page.name, attr(page.lect, 'legal_name')]) {
      add(byName, organizationNameKey(name), page);
    }
  }

  const candidatesFor = (organization: IncomingOrganization): CmsPage[] => {
    const byPageId = organization.pageId === null ? undefined : byId.get(organization.pageId);
    if (byPageId) return [byPageId];
    for (const key of ['registration_no', 'tax_id'] as const) {
      const value = (organization.attrs[key] ?? '').trim().toLowerCase();
      if (value && byAttr[key].has(value)) return byAttr[key].get(value)!;
    }
    for (const key of organization.nameKeys) {
      if (byName.has(key)) return byName.get(key)!;
    }
    return [];
  };

  const consumed = new Set<number>();
  return incoming.map((organization) => {
    const available = candidatesFor(organization).filter((page) => !consumed.has(page.id));
    if (!available.length) return { state: 'new' as const, incoming: organization, changes: [] };
    // Prefer a zero-diff match so re-importing an export stays idempotent.
    const scored = available.map((page) => ({ page, changes: diffIncoming(organization, page) }));
    const match = scored.find((entry) => entry.changes.length === 0) ?? scored[0];
    consumed.add(match.page.id);
    return {
      state: match.changes.length ? 'update' as const : 'unchanged' as const,
      incoming: organization,
      existing: match.page,
      changes: match.changes,
    };
  });
}
