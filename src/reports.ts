// ============================================================
// Contact-quality report — ported from the legacy controller/admin/Report.mjs
// tier analysis. A contact's reachability tier counts its DIRECT contact
// methods (any phone, any direct email, any social media):
//   tier 1 = all three  ·  tier 2 = two  ·  tier 3 = one
//   tier 4 = only company-level contact (general phone/email/fax on a position)
//   tier 5 = no way to reach them
//
// The legacy user-usage report is NOT ported: it read the host's audit tables
// directly, which the F1 API deliberately doesn't expose to plugins.
// ============================================================

import { CmsClient, contactRow, items, type CmsPage } from './cms';
import { ADMIN_BASE } from './contacts';
import { adminView } from '@lionrockjs/worker-cms-plugin';

const SCAN_LIMIT = 500;
const SAMPLES_PER_TIER = 8;

const TIER_LABELS: Record<number, string> = {
  1: 'Phone + email + social media',
  2: 'Two direct contact methods',
  3: 'One direct contact method',
  4: 'Company-level contact only',
  5: 'No contact method',
};

export async function contactQualityReport(cms: CmsClient, views: Fetcher, jsonOnly = false): Promise<Response> {
  const contacts: CmsPage[] = [];
  for (let offset = 0; ; offset += SCAN_LIMIT) {
    const { pages, total } = await cms.list('contact', { limit: SCAN_LIMIT, offset });
    contacts.push(...pages);
    if (offset + pages.length >= total || pages.length === 0) break;
  }

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const samples: Record<number, Array<{ name: string; organization: string; editHref: string }>> = { 1: [], 2: [], 3: [], 4: [], 5: [] };

  for (const page of contacts) {
    const tier = contactTier(page.lect);
    counts[tier] += 1;
    if (samples[tier].length < SAMPLES_PER_TIER) {
      const row = contactRow(page);
      samples[tier].push({ name: row.name, organization: row.organization, editHref: row.editHref });
    }
  }

  const total = contacts.length;
  return adminView(views, 'Reports — contact quality', 'reports', {
    backHref: `${ADMIN_BASE}/contacts`,
    total,
    tiers: [1, 2, 3, 4, 5].map((tier) => ({
      tier,
      label: TIER_LABELS[tier],
      count: counts[tier],
      percent: total ? Math.round((counts[tier] / total) * 100) : 0,
      samples: samples[tier],
      hasSamples: samples[tier].length > 0,
    })),
  }, jsonOnly);
}

/** Direct-method tier per the legacy analyzeContactTier rules. */
export function contactTier(lect: Record<string, unknown>): 1 | 2 | 3 | 4 | 5 {
  const has = (value: unknown): boolean => String(value ?? '').trim() !== '';

  let hasPhone = items(lect, 'phone').some((entry) => has(entry.phone));
  let hasEmail = items(lect, 'email').some((entry) => has(entry.email));
  let hasGeneralOnly = false;
  for (const position of items(lect, 'position')) {
    if (has(position.direct_phone)) hasPhone = true;
    if (has(position.email)) hasEmail = true;
    if (has(position.general_phone) || has(position.general_email) || has(position.fax)) hasGeneralOnly = true;
  }
  for (const assistant of items(lect, 'assistant')) {
    if (has(assistant.mobile) || has(assistant.work_phone)) hasPhone = true;
    if (has(assistant.email)) hasEmail = true;
  }
  for (const spouse of items(lect, 'spouse')) {
    if (has(spouse.phone)) hasPhone = true;
    if (has(spouse.email)) hasEmail = true;
  }
  for (const home of items(lect, 'home')) {
    if (has(home.phone)) hasPhone = true;
  }
  const hasSocial = items(lect, 'social_media').some((entry) => has(entry.url));

  const methods = [hasPhone, hasEmail, hasSocial].filter(Boolean).length;
  if (methods === 3) return 1;
  if (methods === 2) return 2;
  if (methods === 1) return 3;
  if (hasGeneralOnly) return 4;
  return 5;
}
