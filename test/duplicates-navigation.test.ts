import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { duplicateContacts } from '../src/contact-duplicates';
import { contactEmails, CmsClient, type CmsPage } from '../src/cms';
import { primaryEdmEmail, assistantCcEmails } from '../src/contact-email';
import { checkDuplicate, contactsIndex } from '../src/contacts';
function person(id: number, lect: Record<string, unknown>): CmsPage {
  return { id, uuid: String(id), name: `Person ${id}`, slug: String(id), page_type: 'contact', lect, page_id: null, weight: 0, start: null, end: null, timezone: null, created_at: '', updated_at: '' };
}
afterEach(() => vi.unstubAllGlobals());
describe('complete contact duplicate matching', () => {
  it('normalizes the inventory without making spouse addresses eligible eDM recipients', () => {
    const lect = { email: [{ email: 'Ada@Example.com ' }], position: [{ email: 'Work@example.com', general_email: 'Office@example.com' }], assistant: [{ email: 'PA@example.com' }, { email: ' ada@example.com' }], spouse: [{ email: 'Spouse@example.com' }] };
    expect(contactEmails(lect)).toEqual(['ada@example.com', 'work@example.com', 'office@example.com', 'pa@example.com', 'spouse@example.com']);
    expect(primaryEdmEmail(lect)).toBe('Ada@Example.com'); expect(assistantCcEmails(lect)).toEqual(['PA@example.com']);
    expect(primaryEdmEmail({ spouse: lect.spouse })).toBe('');
  });
  it('finds exact normalized matches past 50 and 500 candidates while excluding substring matches', async () => {
    const pages = Array.from({ length: 502 }, (_, i) => person(i + 1, { email: [{ email: i < 500 ? `prefix-target@example.com` : ' TARGET@example.com ' }] }));
    const queries: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); queries.push(url);
      const offset = Number(url.searchParams.get('offset') || '0'); const limit = Number(url.searchParams.get('limit'));
      return Response.json({ pages: pages.slice(offset, offset + limit), total: pages.length });
    }));
    const cms = new CmsClient({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret' });
    const response = await checkDuplicate(cms, new URL('https://contacts.test/check-duplicate.json?email=%20TARGET@EXAMPLE.COM%20'));
    expect((await response.json() as { duplicates: Array<{ id: number }> }).duplicates.map(p => p.id)).toEqual([501, 502]);
    expect(queries.map(url => url.searchParams.get('offset') || '0')).toEqual(['0', '500']);
    expect(queries.every(url => url.searchParams.get('page_type') === 'contact')).toBe(true);
  });
  it('includes assistant/spouse identities, deduplicates results and preserves exact name matching', async () => {
    const pages = [person(1, { assistant: [{ email: 'shared@example.com' }] }), person(2, { spouse: [{ email: 'shared@example.com' }] }), person(3, { full_name: { en: 'Ada' } })];
    const cms = { list: vi.fn(async () => ({ pages, total: 3 })) } as unknown as CmsClient;
    expect((await duplicateContacts(cms, 'shared@example.com', 'ada')).map(page => page.id)).toEqual([1, 2, 3]);
    expect((await duplicateContacts(cms, '', 'ad')).length).toBe(0);
  });
  it('stops on an empty page even if a concurrent count is stale', async () => {
    const list = vi.fn(async () => ({ pages: [], total: 1000 }));
    expect(await duplicateContacts({ list } as unknown as CmsClient, 'none@example.com', '')).toEqual([]); expect(list).toHaveBeenCalledTimes(1);
  });
});
it('links simple contact search to contact-scoped host advanced search, preserving the term', async () => {
  const cms = { list: vi.fn(async () => ({ pages: [], total: 0 })) } as unknown as CmsClient;
  const views = { async fetch() { return new Response('{}'); } } as unknown as Fetcher;
  const response = await contactsIndex(cms, views, new URL('https://contacts.test/contacts?q=Ada%20%26%20Co'), { canRead: true, canCreate: false, canUpdate: false, canDelete: false }, true);
  const { data: props } = await response.json() as { data: { advancedSearchHref: string } };
  const url = new URL(props.advancedSearchHref, 'https://cms.test');
  expect(url.pathname).toBe('/admin/advanced-search/contact'); expect(url.searchParams.get('search1')).toBe('Ada & Co');
  const template = await readFile(fileURLToPath(new URL('../views/sections/contacts.liquid', import.meta.url).href), 'utf8');
  expect(template).toContain('href="{{ advancedSearchHref }}"');
});
