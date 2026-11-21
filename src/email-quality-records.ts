import { CmsApiError, type CmsClient, type CmsPage } from './cms';

export const qualityEmail = (value: unknown): string => String(value ?? '').trim().toLowerCase();
export interface QualityInput { email: string; quality?: string; status?: string; result?: string; free?: string; source?: string; contact_id?: string }
export const QUALITY_STATUSES = ['verified', 'unverified', 'risky', 'invalid', 'pending'] as const;
export function qualityStatus(record: Record<string, unknown>): string {
  const status = String(record.status || '');
  if (QUALITY_STATUSES.includes(status as typeof QUALITY_STATUSES[number])) return status;
  const value = record.quality;
  if (value === '' || value === undefined || value === null) return 'unverified';
  const score = Number(value);
  return !Number.isFinite(score) ? 'unverified' : score >= 100 ? 'verified' : score <= 0 ? 'invalid' : 'risky';
}
export function qualityDelivery(record: CmsPage | undefined, fallback: 'good' | 'risky' | 'invalid'): 'good' | 'risky' | 'invalid' {
  if (!record || fallback === 'invalid') return fallback;
  const status = qualityStatus(record.lect);
  return status === 'verified' ? 'good' : status === 'invalid' ? 'invalid' : 'risky';
}
export async function qualitySlug(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(qualityEmail(email)));
  return 'eq-' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
/** Exact lookups in bounded batches; reports are private draft pages, never published. */
export async function readEmailQuality(cms: Pick<CmsClient, 'request'>, emails: string[], optional = true): Promise<Map<string, CmsPage>> {
  const wanted = [...new Set(emails.map(qualityEmail).filter(Boolean))];
  const wantedSet = new Set(wanted);
  const slugs = await Promise.all(wanted.map(qualitySlug));
  const result = new Map<string, CmsPage>();
  for (let offset = 0; offset < slugs.length; offset += 200) {
    const params = new URLSearchParams({ page_type: 'email_quality', slugs: slugs.slice(offset, offset + 200).join(','), limit: '500' });
    let pages: CmsPage[];
    try { pages = (await cms.request<{ pages: CmsPage[] }>('GET', `/pages?${params}`)).pages; }
    catch (error) {
      if (optional && error instanceof CmsApiError && [403, 404].includes(error.status)) return new Map();
      throw error;
    }
    for (const page of pages) {
      const email = qualityEmail(page.lect.email || page.name);
      if (page.page_type !== 'email_quality' || !wantedSet.has(email)) continue;
      if (result.has(email)) throw new Error(`Multiple quality records for ${email}. Resolve them before updating.`);
      result.set(email, page);
    }
  }
  return result;
}
