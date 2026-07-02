// ============================================================
// Contacts Suite CMS bridge.
//
// Shared F1 client/types and neutral lect readers live in
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
  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, init),
    });
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
