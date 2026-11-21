import { adminView } from '@lionrockjs/worker-cms-plugin';
import { contactDisplayName, items, pointer, type CmsClient } from './cms';
import { ADMIN_BASE } from './contacts';
import manifest from './manifest.json';
import type { ContactsAccess } from './permissions';

const groupNames: Record<string, string> = {
  position: 'Positions',
  email: 'Email addresses',
  phone: 'Phone numbers',
  social_media: 'Social media',
  home: 'Home addresses',
  other_address: 'Other addresses',
  spouse: 'Spouse',
  assistant: 'Assistants',
  nickname: 'Nicknames',
  event_history: 'Event history',
};

const fieldLabels: Record<string, string> = {
  prefer_language: 'Preferred language',
  optout_email: 'Email opt-out',
  optout_mobile: 'Mobile opt-out',
  primary_email: 'Primary eDM email',
  direct_phone_ext: 'Direct phone extension',
  group_rsvp: 'Group RSVP',
};

const cardKeys = ['attachment', 'attachment2'];

function fieldValues(value: unknown): string[] {
  const entries = value && typeof value === 'object' ? Object.values(value) : [value];
  return [...new Set(entries.flatMap(entry => {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') return [];
    const value = String(entry).trim();
    return value ? [value] : [];
  }))];
}

function profileFields(lect: Record<string, unknown>, definitions: string[]) {
  return definitions.flatMap(definition => {
    const [key] = definition.replace(/^[@*]/, '').split(':');
    const isPointer = definition.startsWith('*');
    const values = fieldValues(isPointer ? pointer(lect, key) : lect[key]);
    if (!values.length) return [];
    const title = key.replaceAll('_', ' ').replace(/\b(?:id|rsvp|url)\b/g, acronym => acronym.toUpperCase());
    const label = fieldLabels[key] ?? (isPointer ? `${title[0].toUpperCase()}${title.slice(1)} ID` : title[0].toUpperCase() + title.slice(1));
    return [{ label, values, isDate: key === 'date' || key === 'birthday', isDateTime: key === 'updated_at' }];
  });
}

function cardUrl(value: string): string {
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

export async function contactProfile(
  cms: CmsClient,
  views: Fetcher,
  id: number,
  url: URL,
  access: ContactsAccess,
  jsonOnly: boolean,
): Promise<Response> {
  if (!Number.isSafeInteger(id)) return new Response('not found', { status: 404 });
  const { pages } = await cms.list('contact', { ids: [id], includeTags: true, limit: 1, count: false });
  const page = pages.find(page => page.id === id && page.page_type === 'contact');
  if (!page) return new Response('not found', { status: 404 });

  const { lect } = page;
  const name = contactDisplayName(page);
  const fieldDefinitions = [];
  const groups = [];
  for (const definition of manifest.contentTypes.blueprint.contact) {
    if (typeof definition === 'string') {
      if (!cardKeys.some(key => definition.startsWith(`@${key}:`))) fieldDefinitions.push(definition);
      continue;
    }
    for (const [key, rowFields] of Object.entries(definition)) {
      const rows = items(lect, key)
        .filter(row => row && typeof row === 'object')
        .map(row => profileFields(row, key === 'spouse' ? [...rowFields, '@mobile'] : rowFields))
        .filter(row => row.length);
      if (rows.length) groups.push({ label: groupNames[key] ?? key, rows });
    }
  }
  const fields = profileFields(lect, fieldDefinitions);
  if (fields.length) groups.splice(groups[0]?.label === groupNames.position ? 1 : 0, 0, { label: 'Contact details', rows: [fields] });

  const tagsByTaxonomy = new Map<string, string[]>();
  for (const tag of page.tags ?? []) {
    const names = tagsByTaxonomy.get(tag.taxonomy) ?? [];
    names.push(tag.name);
    tagsByTaxonomy.set(tag.taxonomy, names);
  }
  const tagGroups = [...tagsByTaxonomy].map(([label, tags]) => ({ label, tags }));
  const cards = cardKeys.flatMap(key => fieldValues(lect[key]).flatMap(value => {
    const href = cardUrl(value);
    return href ? [href] : [];
  }));

  const params = new URLSearchParams();
  for (const key of ['q', 'offset']) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const query = params.size ? `?${params}` : '';
  const backHref = `${ADMIN_BASE}/contacts${query}`;
  const profileHref = `${ADMIN_BASE}/contacts/${id}${query}`;

  return adminView(views, `View contact · ${name}`, 'contact-profile', {
    name, groups, tagGroups, cards, backHref,
    dateOptions: { dateStyle: 'medium', timeZone: 'UTC' },
    editHref: access.canUpdate ? `/admin/pages/${id}/edit?return_to=${encodeURIComponent(profileHref)}` : '',
  }, jsonOnly);
}
