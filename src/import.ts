// ============================================================
// Contact import (CSV + VCF) with a two-step preview → confirm flow, ported
// from the legacy import-v2 (controller/admin/Contact.mjs + helper/Importer.mjs)
// using the same architecture as the events plugin's guest import:
//
//  - POST /contacts/import          → parse + classify, NO writes (preview)
//  - POST /contacts/import/confirm  → re-parse + re-classify server-side, apply
//
// The preview carries the RAW file text in a hidden field (not an expanded
// plan), so confirm can't be smuggled into writing other pages. Rows match an
// existing contact by legacy id → any email → full-name key, each existing
// contact consumed once, so re-importing the same file is idempotent.
// Creates run in small chunks (the host does several D1 ops per created page).
// XLSX is NOT parsed — export/convert to CSV first (legacy Excel `="…"` armor
// and a UTF-8 BOM are tolerated).
// ============================================================

import { CmsClient, attr, contactDisplayName, contactEmails, items, localized, type CmsPage, type CmsPageInput } from './cms';
import { ADMIN_BASE } from './contacts';
import { adminView } from '@lionrockjs/worker-cms-plugin';

const IMPORT_CHUNK = 25;
const MATCH_FETCH_LIMIT = 500;

// ── Incoming shape ─────────────────────────────────────────────────────────────

interface IncomingContact {
  /** Legacy export contact_id, stored as the `id` attr. */
  legacyId: string;
  attrs: Record<string, string>;
  /** Localized top-level values, keyed by field then language. */
  values: Record<string, Record<string, string>>;
  itemGroups: Record<string, Array<Record<string, unknown>>>;
  /** All emails found anywhere in the row (matching key). */
  emails: string[];
  nameKey: string;
  displayName: string;
  organization: string;
}

// ── Upload form ────────────────────────────────────────────────────────────────

export async function importForm(views: Fetcher, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Import contacts', 'contact-import', {
    action: `${ADMIN_BASE}/contacts/import`,
    backHref: `${ADMIN_BASE}/contacts`,
    sampleHref: `${ADMIN_BASE}/contacts/export-sample`,
  }, jsonOnly);
}

// ── Preview ────────────────────────────────────────────────────────────────────

export async function previewImport(request: Request, cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
  const { text, error } = await readUpload(request);
  if (error) return importError(views, error, jsonOnly);
  let incoming: IncomingContact[];
  try {
    incoming = parseUpload(text);
  } catch (parseError) {
    return importError(views, parseError instanceof Error ? parseError.message : 'Unable to parse the file.', jsonOnly);
  }
  if (!incoming.length) return importError(views, 'No contact rows found in the file.', jsonOnly);

  const existing = await fetchExistingContacts(cms);
  const plan = classifyImport(incoming, existing);

  return adminView(views, 'Import contacts — preview', 'contact-import-preview', {
    confirmAction: `${ADMIN_BASE}/contacts/import/confirm`,
    backHref: `${ADMIN_BASE}/contacts/import`,
    raw: text,
    rows: plan.map((row) => ({
      state: row.state,
      isNew: row.state === 'new',
      isUpdate: row.state === 'update',
      name: row.incoming.displayName,
      email: row.incoming.emails[0] ?? '',
      organization: row.incoming.organization,
      changes: row.changes,
      hasChanges: row.changes.length > 0,
    })),
    newCount: plan.filter((row) => row.state === 'new').length,
    updateCount: plan.filter((row) => row.state === 'update').length,
    unchangedCount: plan.filter((row) => row.state === 'unchanged').length,
  }, jsonOnly);
}

// ── Confirm ────────────────────────────────────────────────────────────────────

export async function confirmImport(request: Request, cms: CmsClient): Promise<Response> {
  const form = await request.formData();
  const text = String(form.get('raw') ?? '');
  const mode = String(form.get('mode') ?? 'new_and_update');
  if (!text.trim()) return redirect(`${ADMIN_BASE}/contacts`);

  const incoming = parseUpload(text);
  const existing = await fetchExistingContacts(cms);
  const plan = classifyImport(incoming, existing);

  let created = 0;
  let updated = 0;

  const creates = mode === 'update_only' ? [] : plan.filter((row) => row.state === 'new');
  for (let start = 0; start < creates.length; start += IMPORT_CHUNK) {
    const chunk = creates.slice(start, start + IMPORT_CHUNK);
    await cms.batchCreate(chunk.map((row) => toCreateInput(row.incoming)));
    created += chunk.length;
  }

  if (mode !== 'new_only') {
    for (const row of plan) {
      if (row.state !== 'update' || !row.existing) continue;
      await cms.update(row.existing.id, { lect: toLect(row.incoming) });
      updated += 1;
    }
  }

  return redirect(`${ADMIN_BASE}/contacts?imported=${created}&updated=${updated}`);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

function parseUpload(text: string): IncomingContact[] {
  const cleaned = text.replace(/^﻿/, '');
  if (/BEGIN:VCARD/i.test(cleaned)) return parseVcf(cleaned);
  return parseContactCsv(cleaned);
}

/** Column aliases: legacy export header → canonical handling. */
function parseContactCsv(text: string): IncomingContact[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.replace(/^﻿/, '').trim().toLowerCase());
  const contacts: IncomingContact[] = [];
  for (const cells of rows.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = deArmor((cells[index] ?? '').trim());
    });
    const contact = recordToContact(record);
    if (contact) contacts.push(contact);
  }
  return contacts;
}

/** Attribute columns copied verbatim (CSV header → contact attr). */
const ATTR_COLUMNS: Record<string, string> = {
  contact_id: 'id',
  source: 'source',
  date_updated: 'updated_at',
  prefix: 'prefix',
  suffix: 'suffix',
  gender: 'gender',
  countryregion: 'region',
  nationality: 'nationality',
  referral_by: 'referral_by',
  remarks_contact: 'remarks',
  email_status: 'email_status',
};

function recordToContact(record: Record<string, string>): IncomingContact | null {
  const get = (key: string): string => record[key] ?? '';

  const attrs: Record<string, string> = {};
  for (const [column, attrKey] of Object.entries(ATTR_COLUMNS)) {
    if (get(column)) attrs[attrKey] = get(column);
  }

  const values: Record<string, Record<string, string>> = {};
  const setValue = (field: string, language: string, value: string): void => {
    if (!value) return;
    values[field] = { ...(values[field] ?? {}), [language]: value };
  };
  setValue('first_name', 'en', get('first_name'));
  setValue('last_name', 'en', get('last_name'));
  setValue('full_name', 'en', get('full_name'));
  setValue('full_name', 'zh-hant', get('chinese_name_tc'));
  setValue('full_name', 'zh-hans', get('chinese_name_sc'));
  setValue('bio', 'en', get('bio_background'));

  const itemGroups: Record<string, Array<Record<string, unknown>>> = {};
  const push = (group: string, item: Record<string, unknown>): void => {
    // `type` is a constant discriminator (mobile/personal/…) — a row counts as
    // non-empty only when it carries an actual value besides it.
    const meaningful = Object.entries(item).some(([key, value]) =>
      key !== 'type' && value !== '' && value !== undefined && !isEmptyLocalized(value));
    if (!meaningful) return;
    itemGroups[group] = [...(itemGroups[group] ?? []), item];
  };

  for (let n = 1; n <= 5; n++) {
    push('position', {
      client: en(get(`client_name_${n}`)),
      website: get(`office_website_${n}`),
      direct_phone: get(`work_phone_${n}_direct`),
      general_phone: get(`work_phone_general_${n}`),
      fax: get(`office_fax_${n}`),
      email: get(`email_work_${n}`).toLowerCase(),
      general_email: get(`email_general_${n}`).toLowerCase(),
      organization_name: en(get(`company_${n}`)),
      department: en(get(`department_${n}`)),
      title: en(get(`title_${n}`)),
      address: en(get(`business_address_${n}`)),
    });
  }
  for (let n = 1; n <= 3; n++) push('email', { type: 'personal', email: get(`email_personal_${n}`).toLowerCase() });
  for (let n = 1; n <= 3; n++) push('phone', { type: 'mobile', phone: get(`mobile_${n}`) });
  for (let n = 1; n <= 2; n++) {
    push('home', { phone: get(`home_phone_${n}`), address: en(n === 1 ? get('home_address_1') : '') });
  }
  push('spouse', { name: en(get('spouses_name')), phone: get('mobile_spouse'), email: get('email_spouse').toLowerCase() });
  for (let n = 1; n <= 2; n++) {
    push('assistant', {
      name: en(get(`assistants_${n}_name`)),
      mobile: get(`assistants_${n}_mobile`),
      work_phone: get(`assistants_${n}_work_phone`),
      email: get(`assistants_${n}_email`).toLowerCase(),
    });
  }
  push('nickname', { name: get('nickname') });
  if (get('instagram')) push('social_media', { type: 'instagram', url: get('instagram') });
  if (get('facebook')) push('social_media', { type: 'facebook', url: get('facebook') });
  push('other_address', { address: en(get('other_address')) });

  return buildIncoming(attrs, values, itemGroups);
}

/** Minimal VCF 3.0/4.0 parser: N/FN/EMAIL/TEL/ORG/TITLE/ADR/NOTE per card. */
function parseVcf(text: string): IncomingContact[] {
  const contacts: IncomingContact[] = [];
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  for (const card of cards) {
    // Unfold continuation lines (RFC 6350 §3.2).
    const lines = card.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const attrs: Record<string, string> = {};
    const values: Record<string, Record<string, string>> = {};
    const itemGroups: Record<string, Array<Record<string, unknown>>> = {};
    let organization = '';
    let title = '';
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const rawKey = line.slice(0, colon).split(';')[0].trim().toUpperCase();
      const value = line.slice(colon + 1).trim();
      if (!value || rawKey === 'END') continue;
      if (rawKey === 'FN') values.full_name = { en: value };
      else if (rawKey === 'N') {
        const [last, first] = value.split(';');
        if (first) values.first_name = { en: first.trim() };
        if (last) values.last_name = { en: last.trim() };
      } else if (rawKey === 'EMAIL') {
        itemGroups.email = [...(itemGroups.email ?? []), { type: 'personal', email: value.toLowerCase() }];
      } else if (rawKey === 'TEL') {
        itemGroups.phone = [...(itemGroups.phone ?? []), { type: 'mobile', phone: value }];
      } else if (rawKey === 'ORG') organization = value.split(';')[0].trim();
      else if (rawKey === 'TITLE') title = value;
      else if (rawKey === 'NOTE') attrs.remarks = value;
      else if (rawKey === 'ADR') {
        const address = value.split(';').filter(Boolean).join(', ');
        if (address) itemGroups.other_address = [...(itemGroups.other_address ?? []), { address: en(address) }];
      }
    }
    if (organization || title) {
      itemGroups.position = [{ organization_name: en(organization), title: en(title) }];
    }
    const contact = buildIncoming(attrs, values, itemGroups);
    if (contact) contacts.push(contact);
  }
  return contacts;
}

function buildIncoming(
  attrs: Record<string, string>,
  values: Record<string, Record<string, string>>,
  itemGroups: Record<string, Array<Record<string, unknown>>>,
): IncomingContact | null {
  const displayName = values.full_name?.en
    || [values.first_name?.en, values.last_name?.en].filter(Boolean).join(' ');
  const emails = new Set<string>();
  for (const entry of itemGroups.email ?? []) {
    if (entry.email) emails.add(String(entry.email));
  }
  for (const position of itemGroups.position ?? []) {
    if (position.email) emails.add(String(position.email));
    if (position.general_email) emails.add(String(position.general_email));
  }
  if (!displayName && emails.size === 0) return null;
  const firstOrg = (itemGroups.position ?? []).map((position) => {
    const value = position.organization_name;
    return value && typeof value === 'object' ? String((value as Record<string, unknown>).en ?? '') : String(value ?? '');
  }).find(Boolean) ?? '';
  return {
    legacyId: attrs.id ?? '',
    attrs,
    values,
    itemGroups,
    emails: [...emails],
    nameKey: displayName.trim().toLowerCase(),
    displayName: displayName || [...emails][0] || '(no name)',
    organization: firstOrg,
  };
}

// ── Classification ─────────────────────────────────────────────────────────────

interface PlanRow {
  state: 'new' | 'update' | 'unchanged';
  incoming: IncomingContact;
  existing?: CmsPage;
  changes: Array<{ label: string; from: string; to: string }>;
}

export function classifyImport(incoming: IncomingContact[], existing: CmsPage[]): PlanRow[] {
  const byLegacyId = new Map<string, CmsPage[]>();
  const byEmail = new Map<string, CmsPage[]>();
  const byName = new Map<string, CmsPage[]>();
  const consumed = new Set<number>();

  for (const page of existing) {
    const legacyId = attr(page.lect, 'id');
    if (legacyId) byLegacyId.set(legacyId, [...(byLegacyId.get(legacyId) ?? []), page]);
    for (const email of contactEmails(page.lect)) byEmail.set(email, [...(byEmail.get(email) ?? []), page]);
    const nameKey = contactDisplayName(page).trim().toLowerCase();
    if (nameKey) byName.set(nameKey, [...(byName.get(nameKey) ?? []), page]);
  }

  const candidatesFor = (contact: IncomingContact): CmsPage[] => {
    if (contact.legacyId && byLegacyId.has(contact.legacyId)) return byLegacyId.get(contact.legacyId)!;
    for (const email of contact.emails) {
      if (byEmail.has(email)) return byEmail.get(email)!;
    }
    if (contact.nameKey && byName.has(contact.nameKey)) return byName.get(contact.nameKey)!;
    return [];
  };

  return incoming.map((contact) => {
    const available = candidatesFor(contact).filter((page) => !consumed.has(page.id));
    if (!available.length) return { state: 'new' as const, incoming: contact, changes: [] };
    // Prefer a zero-diff match within the group (keeps re-imports idempotent
    // even when several existing contacts share an email or name).
    const scored = available.map((page) => ({ page, changes: diffContact(contact, page) }));
    const match = scored.find((entry) => entry.changes.length === 0) ?? scored[0];
    consumed.add(match.page.id);
    return {
      state: match.changes.length ? 'update' as const : 'unchanged' as const,
      incoming: contact,
      existing: match.page,
      changes: match.changes,
    };
  });
}

/** Field-level diff shown in the preview; compares the projections the import writes. */
function diffContact(incoming: IncomingContact, page: CmsPage): Array<{ label: string; from: string; to: string }> {
  const changes: Array<{ label: string; from: string; to: string }> = [];
  for (const [key, value] of Object.entries(incoming.attrs)) {
    if (key === 'updated_at') continue;
    const previous = attr(page.lect, key);
    if (value !== '' && previous !== value) changes.push({ label: key, from: previous, to: value });
  }
  for (const [field, languages] of Object.entries(incoming.values)) {
    for (const [language, value] of Object.entries(languages)) {
      const previous = localized(page.lect, field, language);
      if (value !== '' && previous !== value) {
        changes.push({ label: language === 'en' ? field : `${field} (${language})`, from: previous, to: value });
      }
    }
  }
  for (const [group, incomingItems] of Object.entries(incoming.itemGroups)) {
    const previous = normalizeItems(items(page.lect, group));
    const next = normalizeItems(incomingItems);
    if (previous !== next) {
      changes.push({ label: group, from: summarizeItems(items(page.lect, group)), to: summarizeItems(incomingItems) });
    }
  }
  return changes;
}

/** Stable projection for item-array comparison (drops seeded-empty rows and ordering noise). */
function normalizeItems(rows: Array<Record<string, unknown>>): string {
  const cleaned = rows
    .map((row) => {
      const entry: Record<string, unknown> = {};
      for (const key of Object.keys(row).sort()) {
        if (key.startsWith('_')) continue;
        const value = row[key];
        if (value === '' || value == null || isEmptyLocalized(value)) continue;
        entry[key] = value;
      }
      return entry;
    })
    .filter((entry) => Object.keys(entry).length > 0);
  return JSON.stringify(cleaned);
}

function summarizeItems(rows: Array<Record<string, unknown>>): string {
  const parsed = JSON.parse(normalizeItems(rows)) as Array<Record<string, unknown>>;
  return parsed
    .map((row) => Object.values(row).map((value) =>
      typeof value === 'object' && value ? Object.values(value as Record<string, unknown>).join('/') : String(value)).join(' '))
    .join('; ');
}

// ── Write shapes ───────────────────────────────────────────────────────────────

function toLect(incoming: IncomingContact): Record<string, unknown> {
  const lect: Record<string, unknown> = { ...incoming.attrs };
  for (const [field, languages] of Object.entries(incoming.values)) lect[field] = languages;
  for (const [group, groupItems] of Object.entries(incoming.itemGroups)) lect[group] = groupItems;
  return lect;
}

function toCreateInput(incoming: IncomingContact): CmsPageInput {
  return {
    page_type: 'contact',
    name: incoming.displayName,
    lect: toLect(incoming),
  };
}

// ── Fetch existing (bounded pagination) ────────────────────────────────────────

async function fetchExistingContacts(cms: CmsClient): Promise<CmsPage[]> {
  const all: CmsPage[] = [];
  for (let offset = 0; ; offset += MATCH_FETCH_LIMIT) {
    const { pages, total } = await cms.list('contact', { limit: MATCH_FETCH_LIMIT, offset });
    all.push(...pages);
    if (offset + pages.length >= total || pages.length === 0) break;
  }
  return all;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

async function readUpload(request: Request): Promise<{ text: string; error?: string }> {
  const form = await request.formData();
  // workers-types may type form entries as string; detect an uploaded File shape.
  const file = form.get('file') as unknown as { name?: string; size?: number; text?: () => Promise<string> } | string | null;
  if (file && typeof file === 'object' && typeof file.text === 'function' && (file.size ?? 0) > 0) {
    if (/\.xlsx?$/i.test(file.name ?? '')) {
      return { text: '', error: 'Excel files are not parsed directly — export/convert to CSV first.' };
    }
    return { text: await file.text() };
  }
  const pasted = String(form.get('raw') ?? '');
  if (pasted.trim()) return { text: pasted };
  return { text: '', error: 'Choose a CSV/VCF file or paste its contents.' };
}

function importError(views: Fetcher, message: string, jsonOnly: boolean): Promise<Response> {
  return adminView(views, 'Import contacts', 'contact-import', {
    action: `${ADMIN_BASE}/contacts/import`,
    backHref: `${ADMIN_BASE}/contacts`,
    sampleHref: `${ADMIN_BASE}/contacts/export-sample`,
    error: message,
  }, jsonOnly);
}

function en(value: string): Record<string, string> | '' {
  return value ? { en: value } : '';
}

function isEmptyLocalized(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => entry === '' || entry == null);
}

/** Strips the legacy Excel `="…"` armor around exported values. */
function deArmor(value: string): string {
  if (!value.startsWith('=')) return value;
  const inner = value.slice(1);
  return inner.startsWith('"') && inner.endsWith('"') ? inner.slice(1, -1) : inner;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
