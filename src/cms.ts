// ============================================================
// Contacts Suite CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin; this file adds the contact-specific
// flatteners the admin list, export, dedupe and import flows share.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
} from '@lionrockjs/worker-cms-plugin';
import {
  withCredits,
  type CmsCreditMethods,
} from '@lionrockjs/worker-cms-plugin-decorator-credits';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'contacts';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
};

export class CmsClient extends BaseCmsClient {
  declare credits: CmsCreditMethods['credits'];
  declare creditQuote: CmsCreditMethods['creditQuote'];
  declare chargeCredits: CmsCreditMethods['chargeCredits'];
  declare reportCreditUsage: CmsCreditMethods['reportCreditUsage'];

  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, init),
    });
    return withCredits(this);
  }

  /** Bulk partial-lect update through `PATCH /__cms/pages/batch` (≤ 100 per
   *  call). The host merges, versions and commits the chunk atomically. */
  async batchUpdate(inputs: Array<{ id: number; lect: Record<string, unknown> }>): Promise<void> {
    if (!inputs.length) return;
    const result = await this.request<{ errors: Array<{ index: number; error: string }> }>(
      'PATCH',
      '/pages/batch',
      { body: { pages: inputs } },
    );
    if (result.errors.length) {
      const first = result.errors[0];
      throw new CmsApiError(400, first.error, 'PATCH', `/pages/batch[${first.index}]`);
    }
  }
}

/** Every email a contact carries: personal email items + per-position work emails. */
export function contactEmails(lect: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const entry of items(lect, 'email')) {
    const email = String(entry.email ?? '').trim().toLowerCase();
    if (email) found.add(email);
  }
  for (const position of items(lect, 'position')) {
    for (const key of ['email', 'general_email']) {
      const email = String(position[key] ?? '').trim().toLowerCase();
      if (email) found.add(email);
    }
  }
  return [...found];
}

/** Every phone number (digits only) — phone items, positions, home rows. */
export function contactPhones(lect: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits) found.add(digits);
  };
  for (const entry of items(lect, 'phone')) add(entry.phone);
  for (const position of items(lect, 'position')) {
    add(position.direct_phone);
    add(position.general_phone);
  }
  for (const home of items(lect, 'home')) add(home.phone);
  return [...found];
}

export function contactDisplayName(page: CmsPage, language = 'en'): string {
  const lect = page.lect;
  return localized(lect, 'full_name', language)
    || [localized(lect, 'first_name', language), localized(lect, 'last_name', language)].filter(Boolean).join(' ')
    || page.name;
}

export interface ContactRow {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  organization: string;
  title: string;
  email: string;
  emails: string[];
  phone: string;
  region: string;
  source: string;
  emailStatus: string;
  editHref: string;
}

/** Flat row for the admin list / export / typeahead. */
export function contactRow(page: CmsPage, language = 'en'): ContactRow {
  const lect = page.lect;
  const firstPosition = items(lect, 'position').find((position) =>
    String(position.organization_name ?? '') !== '' || String(position.title ?? '') !== '') ?? {};
  const emails = contactEmails(lect);
  const phones = contactPhones(lect);
  return {
    id: page.id,
    name: contactDisplayName(page, language),
    firstName: localized(lect, 'first_name', language),
    lastName: localized(lect, 'last_name', language),
    organization: localized(firstPosition, 'organization_name', language),
    title: localized(firstPosition, 'title', language),
    email: emails[0] ?? '',
    emails,
    phone: phones[0] ?? '',
    region: attr(lect, 'region'),
    source: attr(lect, 'source'),
    emailStatus: attr(lect, 'email_status'),
    editHref: `/admin/pages/${page.id}/edit?return_to=${encodeURIComponent(`/admin/plugins/${PLUGIN_ID}/contacts`)}`,
  };
}

/** Case-insensitive name key used for duplicate detection and import matching. */
export function contactNameKey(page: CmsPage): string {
  return contactDisplayName(page).trim().toLowerCase();
}

// ── Organizations ──────────────────────────────────────────────────────────────

/** Name key for matching organizations: case, punctuation and spacing ignored. */
export function organizationNameKey(name: string): string {
  return name
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function organizationDisplayName(page: CmsPage, language = 'en'): string {
  return localized(page.lect, 'name', language) || page.name;
}

/** People rows that actually link a contact (skips the blueprint's seeded empty row). */
export function organizationPeople(lect: Record<string, unknown>): Array<{ contactId: string; role: string }> {
  return items(lect, 'people')
    .map((person) => ({ contactId: pointer(person, 'contact'), role: attr(person, 'role') }))
    .filter((person) => person.contactId !== '');
}

export interface OrganizationRow {
  id: number;
  name: string;
  legalName: string;
  website: string;
  email: string;
  phone: string;
  people: number;
  editHref: string;
}

export function organizationRow(page: CmsPage, language = 'en'): OrganizationRow {
  const lect = page.lect;
  return {
    id: page.id,
    name: organizationDisplayName(page, language),
    legalName: attr(lect, 'legal_name'),
    website: attr(lect, 'website'),
    email: attr(lect, 'general_email'),
    phone: attr(lect, 'general_phone'),
    people: organizationPeople(lect).length,
    editHref: `/admin/pages/${page.id}/edit?return_to=${encodeURIComponent(`/admin/plugins/${PLUGIN_ID}/organizations`)}`,
  };
}
