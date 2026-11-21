import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import worker from '../src/index';
import { CmsClient, type CmsPage } from '../src/cms';
import { parseQualityReport, qualityImport } from '../src/quality-import';
import { qualitySlug, readEmailQuality } from '../src/email-quality-records';
import { emailQualityIndex, setEmailStatus, submitToVerifier } from '../src/email-quality';
const views = { async fetch(input: RequestInfo | URL) { try { return new Response(await readFile(fileURLToPath(new URL(`../views${new URL(String(input)).pathname}`, import.meta.url).href), 'utf8')); } catch { return new Response('not found', { status: 404 }); } } } as Fetcher;
function page(id: number, type: string, name: string, lect: Record<string, unknown> = {}, slug = String(id)): CmsPage {
  return { id, page_type: type, name, lect, slug, uuid: String(id), page_id: null, weight: 0, start: null, end: null, timezone: null, created_at: '', updated_at: '' };
}
function setup(pages: CmsPage[] = []) {
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const verification: string[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method || 'GET';
    if (url.origin === 'https://verifier.test') { const emails = (JSON.parse(String(init?.body)) as { emails: string[] }).emails; verification.push(emails); return Response.json(emails.slice(0, 1).map(email => ({ email, status: 'verified' }))); }
    if (method === 'GET' && url.pathname === '/__cms/pages') {
      const type = url.searchParams.get('page_type'); const q = url.searchParams.get('q') || ''; const slugs = url.searchParams.get('slugs')?.split(',');
      const matched = pages.filter(p => p.page_type === type && (!slugs || slugs.includes(p.slug)) && (!q || JSON.stringify(p).includes(q)));
      const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || 500);
      return Response.json({ pages: matched.slice(offset, offset + limit), total: matched.length });
    }
    if (method === 'GET') { const found = pages.find(p => `/__cms/pages/${p.id}` === url.pathname); return found ? Response.json({ page: found }) : new Response('not found', { status: 404 }); }
    const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, method, body });
    if (method === 'POST' && url.pathname === '/__cms/pages') { const created = { ...page(1000 + pages.length, body.page_type, body.name, body.lect, body.slug) }; pages.push(created); return Response.json({ page: created }); }
    const found = pages.find(p => `/__cms/pages/${p.id}` === url.pathname)!; found.lect = { ...found.lect, ...body.lect }; return Response.json({ page: found });
  }));
  return { pages, writes, verification, cms: new CmsClient({ CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret' }) };
}
function post(csv: string) { return new Request('https://contacts.test/import', { method: 'POST', body: new URLSearchParams({ csv }) }); }
afterEach(() => vi.unstubAllGlobals());
describe('legacy verifier report compatibility', () => {
  it('prefers email over person name, handles BOM/headers/quoted cells and maps legacy scores', () => {
    const rows = parseQualityReport('\uFEFF Name , EMAIL , QUALITY , Result,Free,Source,contact_id\nA Person, Ada@Example.com ,good,"deliverable, checked",yes,report,0004\nB,other@example.com,unknown,uncertain,no,report,\n');
    expect(rows).toEqual([{ email: 'ada@example.com', quality: '100', result: 'deliverable, checked', free: 'yes', source: 'report', contact_id: '0004', status: 'verified' }, { email: 'other@example.com', quality: '50', result: 'uncertain', free: 'no', source: 'report', contact_id: '', status: 'risky' }]);
    expect(parseQualityReport('name,quality\nlegacy@example.com,bad')[0]).toMatchObject({ email: 'legacy@example.com', quality: '0', status: 'invalid' });
    expect(parseQualityReport('email,quality\na@example.com,ok\nb@example.com,risky\nc@example.com,invalid').map(row => row.quality)).toEqual(['100', '50', '0']);
  });
  it('rejects conflicting duplicates, bad addresses, scores and malformed files before writes', async () => {
    const f = setup();
    for (const csv of ['email,quality\nx@example.com,good\nX@example.com,bad', 'email,quality\nno-email,good', 'email,quality\na@example.com,101', 'email\n"unclosed', 'name,email\na@example.com,not-email']) {
      await expect(qualityImport(post(csv), f.cms, views, true, true)).rejects.toThrow();
    }
    expect(f.writes).toEqual([]);
  });
  it('previews without writes, stores independent outcomes and preserves missing metadata on repeated imports', async () => {
    const f = setup([page(1, 'contact', 'Ada', { email: [{ email: 'a@example.com' }, { email: 'b@example.com' }] })]);
    const csv = 'email,quality,result,free,source,contact_id\na@example.com,good,deliverable,yes,legacy,1\nb@example.com,invalid,mailbox missing,no,legacy,1';
    const preview = await qualityImport(post(csv), f.cms, views, false, true);
    expect((await preview.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(2); expect(f.writes).toEqual([]);
    expect((await qualityImport(post(csv), f.cms, views, true, true)).status).toBe(303);
    expect(f.pages.filter(p => p.page_type === 'email_quality').map(p => p.lect.quality)).toEqual(['100', '0']);
    const count = f.writes.length; await qualityImport(post(csv), f.cms, views, true, true); expect(f.writes).toHaveLength(count);
    await qualityImport(post('email,quality\na@example.com,risky'), f.cms, views, true, true);
    expect(f.pages.find(p => p.name === 'a@example.com')!.lect).toMatchObject({ quality: '50', result: 'deliverable', free: 'yes', source: 'legacy', contact_id: '1' });
  });
  it('continues large reports idempotently, including zero-progress runtime caps', async () => {
    const f = setup(); const csv = 'email,quality\n' + Array.from({ length: 45 }, (_, i) => `a${i}@example.com,good`).join('\n');
    for (let i = 0; i < 2; i++) { const response = await qualityImport(post(csv), f.cms, views, true, true); expect(response.status).toBe(200); expect((await response.json() as { data: { writes: number } }).data.writes).toBe(20); }
    expect((await qualityImport(post(csv), f.cms, views, true, true)).status).toBe(303); expect(f.writes).toHaveLength(45);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname === '/__cms/pages') throw new Error('Too many subrequests');
      return original(input, init);
    }));
    const capped = await qualityImport(post('email,quality\nnew@example.com,good'), f.cms, views, true, true);
    expect((await capped.json() as { data: { writes: number } }).data.writes).toBe(0);
  });
  it('shows per-address results on every matching contact and standalone imported addresses', async () => {
    const f = setup([page(1, 'contact', 'A', { email: [{ email: 'shared@example.com' }], spouse: [{ email: 'spouse@example.com' }] }), page(2, 'contact', 'B', { assistant: [{ email: 'shared@example.com' }] })]);
    await qualityImport(post('email,quality\nshared@example.com,good\nspouse@example.com,bad\nunlinked@example.com,risky'), f.cms, views, true, true);
    const response = await emailQualityIndex(f.cms, views, {}, new URL('https://contacts.test?q=shared@example.com'), true);
    expect((await response.json() as { data: { rows: Array<{ status: string }> } }).data.rows.map(row => row.status)).toEqual(['verified', 'verified']);
    const standalone = await emailQualityIndex(f.cms, views, {}, new URL('https://contacts.test?q=unlinked@example.com'), true);
    expect((await standalone.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(1);
    const form = new URLSearchParams({ contact_id: '1', email: 'spouse@example.com', status: 'verified' });
    expect((await setEmailStatus(new Request('https://contacts.test/status', { method: 'POST', body: form }), f.cms)).status).toBe(303);
    expect(f.pages.find(p => p.name === 'shared@example.com')!.lect.status).toBe('verified');
    expect(f.pages[0].lect.email_status).toBeUndefined();
    form.set('email', 'outsider@example.com'); expect((await setEmailStatus(new Request('https://contacts.test/status', { method: 'POST', body: form }), f.cms)).status).toBe(400);
  });
  it('deduplicates all address classes in bounded verifier submissions and stores missing responses as pending', async () => {
    const f = setup([page(1, 'contact', 'A', { email: [{ email: 'a@example.com' }], position: [{ email: 'work@example.com', general_email: 'general@example.com' }], assistant: [{ email: 'pa@example.com' }], spouse: [{ email: 'spouse@example.com' }] }), page(2, 'contact', 'B', { email: [{ email: 'A@example.com' }] })]);
    const env = { VERIFIER_API_URL: 'https://verifier.test/check', VERIFIER_API_KEY: 'fake' };
    await submitToVerifier(f.cms, env); expect(f.verification[0]).toEqual(['a@example.com', 'work@example.com', 'general@example.com', 'pa@example.com', 'spouse@example.com']);
    expect(f.pages.filter(p => p.page_type === 'email_quality').map(p => p.lect.status)).toEqual(['verified', 'pending', 'pending', 'pending', 'pending']);
    const count = f.verification.length; await submitToVerifier(f.cms, env); expect(f.verification).toHaveLength(count);
  });
  it('looks up more than one CMS page of quality records in bounded exact batches', async () => {
    const records = await Promise.all(Array.from({ length: 700 }, async (_, i) => page(i + 1, 'email_quality', `a${i}@example.com`, { email: `a${i}@example.com`, quality: '100' }, await qualitySlug(`a${i}@example.com`))));
    const f = setup(records);
    expect((await readEmailQuality(f.cms, records.map(record => record.name))).size).toBe(700);
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls.every(([input]) => new URL(String(input)).searchParams.get('slugs')!.split(',').length <= 200)).toBe(true);
    expect(f.writes).toEqual([]);
  });
  it('uses normalized exact lookups and requires write permission for report confirmation', async () => {
    const f = setup(); expect(await qualitySlug(' A@Example.com ')).toBe(await qualitySlug('a@example.com'));
    await qualityImport(post('email,quality\na@example.com,good'), f.cms, views, true, true);
    expect((await readEmailQuality(f.cms, [' A@EXAMPLE.COM '])).size).toBe(1);
    const response = await worker.fetch(new Request('https://contacts.test/__plugin/admin/email-quality/import/confirm', { method: 'POST', headers: { 'x-plugin-secret': 'secret', 'x-cms-user': JSON.stringify({ role: 'viewer', permissions: ['contacts:read'] }) }, body: new URLSearchParams({ csv: 'email,quality\na@example.com,bad' }) }), { CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret', VIEWS: views });
    expect(response.status).toBe(403); expect(f.writes).toHaveLength(1);
  });
});
