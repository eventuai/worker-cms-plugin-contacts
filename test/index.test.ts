// ============================================================
// Contacts suite tests — drive the plugin Worker directly with a mocked
// global fetch standing in for the CMS Plugin API ({CMS_URL}/__cms/*), the same
// pattern as the events plugin's suite. Client-view responses are rendered
// through the real Liquid templates so assertions cover the actual HTML.
// ============================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { renderView } from '../src/templates/liquid';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  VERIFIER_API_URL?: string;
  VERIFIER_API_KEY?: string;
  VIEWS: Fetcher;
}

const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return { VIEWS: views(), CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'shared-secret', ...overrides };
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (!headers.has('x-plugin-secret')) headers.set('x-plugin-secret', 'shared-secret');
  return new Request(`https://contacts.test${path}`, { ...init, headers });
}

interface FakePage {
  id: number;
  page_type: string;
  name: string;
  page_id?: number | null;
  lect: Record<string, unknown>;
}

/** Fake Plugin API: GET /pages list (with naive q over JSON), GET/PUT /pages/:id, POST /pages/batch. */
function fakeCms(pages: FakePage[]) {
  const puts: Array<{ id: number; body: Record<string, unknown> }> = [];
  const batches: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname === '/__cms/pages' && (!init?.method || init.method === 'GET')) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const type = url.searchParams.get('page_type');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const matched = pages.filter((page) => page.page_type === type
        && (!q || `${page.name} ${JSON.stringify(page.lect)}`.toLowerCase().includes(q)));
      return Response.json({ pages: matched.slice(offset, offset + limit), total: matched.length });
    }
    if (url.pathname === '/__cms/pages/batch' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      batches.push(body);
      const inputs = body.pages as Array<Record<string, unknown>>;
      return Response.json({ pages: inputs.map((page, index) => ({ id: 900 + index, ...page })) });
    }
    const idMatch = url.pathname.match(/^\/__cms\/pages\/(\d+)$/);
    if (idMatch && init?.method === 'PUT') {
      puts.push({ id: Number(idMatch[1]), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ page: { id: Number(idMatch[1]) } });
    }
    if (idMatch) {
      const page = pages.find((entry) => entry.id === Number(idMatch[1]));
      return page ? Response.json({ page }) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { puts, batches, fetcher };
}

function contact(id: number, name: string, lect: Record<string, unknown> = {}): FakePage {
  return { id, page_type: 'contact', name, lect };
}

const ADA = contact(11, 'Ada Lovelace', {
  id: 'C-1001',
  region: 'Hong Kong',
  first_name: { en: 'Ada' },
  last_name: { en: 'Lovelace' },
  full_name: { en: 'Ada Lovelace' },
  email: [{ type: 'personal', email: 'ada@personal.example' }],
  phone: [{ type: 'mobile', phone: '+852 9876 5432' }],
  position: [{ organization_name: { en: 'Analytical Engines' }, title: { en: 'Director' }, email: 'ada@example.com' }],
  social_media: [{ type: 'instagram', url: 'https://instagram.com/ada' }],
});

const GRACE = contact(12, 'Grace Hopper', {
  full_name: { en: 'Grace Hopper' },
  position: [{ organization_name: { en: 'Navy' }, general_phone: '+1 555 0100' }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contacts admin', () => {
  it('lists and searches contacts with rows linking to the CMS editor', async () => {
    fakeCms([ADA, GRACE]);
    const response = await plugin.fetch(request('/__plugin/admin/contacts?q=ada'), env());
    const html = await renderedText(response);

    expect(response.status).toBe(200);
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Analytical Engines');
    expect(html).toContain('ada@personal.example');
    expect(html).toContain('/admin/pages/11/edit');
    expect(html).not.toContain('Grace Hopper');
  });

  it('exports the search results as CSV', async () => {
    fakeCms([ADA, GRACE]);
    const response = await plugin.fetch(request('/__plugin/admin/contacts/export'), env());
    const csv = await response.text();

    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('"contact_id"');
    expect(csv).toContain('"Ada"');
    expect(csv).toContain('"Grace Hopper"');
  });

  it('detects duplicates by email and by name', async () => {
    fakeCms([ADA, GRACE]);
    const byEmail = await plugin.fetch(request('/__plugin/admin/contacts/check-duplicate.json?email=ada@example.com'), env());
    const emailResult = await byEmail.json() as { duplicates: Array<{ id: number }> };
    expect(emailResult.duplicates.map((entry) => entry.id)).toEqual([11]);

    const byName = await plugin.fetch(request('/__plugin/admin/contacts/check-duplicate.json?name=grace%20hopper'), env());
    const nameResult = await byName.json() as { duplicates: Array<{ id: number }> };
    expect(nameResult.duplicates.map((entry) => entry.id)).toEqual([12]);
  });

  it('serves the typeahead JSON', async () => {
    fakeCms([ADA, GRACE]);
    const response = await plugin.fetch(request('/__plugin/admin/contacts/search.json?q=navy'), env());
    const result = await response.json() as { contacts: Array<{ id: number; name: string }> };
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({ id: 12, name: 'Grace Hopper' });
  });

  it('denies viewers without contacts permissions', async () => {
    fakeCms([]);
    const response = await plugin.fetch(request('/__plugin/admin/contacts', {
      headers: { 'x-plugin-secret': 'shared-secret', 'x-cms-user': JSON.stringify({ role: 'viewer', permissions: [] }) },
    }), env());
    expect(response.status).toBe(403);
  });
});

describe('contact import', () => {
  const CSV = [
    'contact_id,first_name,last_name,full_name,chinese_name_tc,company_1,title_1,email_work_1,mobile_1,email_personal_1,remarks_contact',
    'C-1001,Ada,Lovelace,Ada Lovelace,愛達,Analytical Engines,Director,ada@example.com,+852 9876 5432,ada@personal.example,VIP',
    'C-2002,Alan,Turing,Alan Turing,,Bletchley,Cryptanalyst,alan@example.com,,,',
  ].join('\n');

  function importRequest(path: string, fields: Record<string, string>): Request {
    const body = new URLSearchParams(fields);
    return request(path, {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  it('previews new vs update vs unchanged without writing', async () => {
    const { puts, batches } = fakeCms([ADA]);
    const response = await plugin.fetch(importRequest('/__plugin/admin/contacts/import', { raw: CSV }), env());
    const html = await renderedText(response);

    expect(html).toContain('1 new · 1 updated · 0 unchanged');
    expect(html).toContain('Alan Turing');
    // Ada exists but the CSV adds remarks + zh-hant full name → update with changes listed
    expect(html).toContain('remarks');
    expect(puts).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it('confirm applies creates in chunks and updates per contact', async () => {
    const { puts, batches } = fakeCms([ADA]);
    const response = await plugin.fetch(importRequest('/__plugin/admin/contacts/import/confirm', { raw: CSV, mode: 'new_and_update' }), env());

    expect(response.status).toBe(303);
    expect(batches).toHaveLength(1);
    const created = (batches[0].pages as Array<Record<string, unknown>>)[0];
    expect(created).toMatchObject({ page_type: 'contact', name: 'Alan Turing' });
    expect(puts).toHaveLength(1);
    expect(puts[0].id).toBe(11);
    const lect = puts[0].body.lect as Record<string, unknown>;
    expect(lect.remarks).toBe('VIP');
    expect((lect.full_name as Record<string, string>)['zh-hant']).toBe('愛達');
  });

  it('re-importing the applied file is idempotent (all unchanged)', async () => {
    // Ada as she would look AFTER the import applied.
    const adaAfter = contact(11, 'Ada Lovelace', {
      ...ADA.lect,
      id: 'C-1001',
      remarks: 'VIP',
      full_name: { en: 'Ada Lovelace', 'zh-hant': '愛達' },
      position: [{
        organization_name: { en: 'Analytical Engines' }, title: { en: 'Director' },
        email: 'ada@example.com', direct_phone: '', general_phone: '', fax: '', general_email: '', website: '',
      }],
    });
    const alanAfter = contact(12, 'Alan Turing', {
      id: 'C-2002',
      first_name: { en: 'Alan' },
      last_name: { en: 'Turing' },
      full_name: { en: 'Alan Turing' },
      position: [{ organization_name: { en: 'Bletchley' }, title: { en: 'Cryptanalyst' }, email: 'alan@example.com' }],
    });
    fakeCms([adaAfter, alanAfter]);
    const response = await plugin.fetch(importRequest('/__plugin/admin/contacts/import', { raw: CSV }), env());
    const html = await renderedText(response);
    expect(html).toContain('0 new');
    expect(html).toContain('2 unchanged');
  });

  it('imports VCF cards', async () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'N:Curie;Marie;;;', 'FN:Marie Curie',
      'EMAIL:marie@example.com', 'TEL:+33 1 23 45', 'ORG:Sorbonne', 'TITLE:Professor', 'END:VCARD',
    ].join('\r\n');
    fakeCms([]);
    const response = await plugin.fetch(importRequest('/__plugin/admin/contacts/import', { raw: vcf }), env());
    const html = await renderedText(response);
    expect(html).toContain('Marie Curie');
    expect(html).toContain('marie@example.com');
    expect(html).toContain('1 new');
  });
});

describe('email quality', () => {
  it('summarizes statuses and lists unverified contacts', async () => {
    fakeCms([
      contact(21, 'Verified Vera', { email: [{ email: 'vera@example.com' }], email_status: 'verified' }),
      contact(22, 'Unverified Uma', { email: [{ email: 'uma@example.com' }] }),
    ]);
    const response = await plugin.fetch(request('/__plugin/admin/email-quality'), env());
    const html = await renderedText(response);

    expect(html).toContain('Unverified emails (1)');
    expect(html).toContain('Unverified Uma');
    expect(html).not.toContain('Verified Vera');
    expect(html).toContain('VERIFIER_API_URL');
  });

  it('sets a manual status over the Plugin API', async () => {
    const { puts } = fakeCms([contact(22, 'Uma', { email: [{ email: 'uma@example.com' }] })]);
    const response = await plugin.fetch(request('/__plugin/admin/email-quality/status', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ contact_id: '22', status: 'verified' }),
    }), env());
    expect(response.status).toBe(303);
    expect(puts).toEqual([{ id: 22, body: { lect: { email_status: 'verified' } } }]);
  });

  it('submits unverified emails to the configured verifier and writes results back', async () => {
    const pages = [contact(22, 'Uma', { email: [{ email: 'uma@example.com' }] })];
    const puts: Array<{ id: number; body: Record<string, unknown> }> = [];
    // One stub covering both the CMS Plugin API and the external verifier.
    const combined = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.origin === 'https://verify.test') {
        return Response.json([{ email: 'uma@example.com', status: 'verified' }]);
      }
      if (url.pathname === '/__cms/pages') {
        return Response.json({ pages, total: pages.length });
      }
      if (url.pathname === '/__cms/pages/22' && init?.method === 'PUT') {
        puts.push({ id: 22, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: { id: 22 } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', combined);

    const response = await plugin.fetch(request('/__plugin/admin/email-quality/submit', {
      method: 'POST',
      headers: { 'x-plugin-secret': 'shared-secret' },
    }), env({ VERIFIER_API_URL: 'https://verify.test/v1/verify', VERIFIER_API_KEY: 'key' }));

    expect(response.status).toBe(303);
    expect(puts).toEqual([{ id: 22, body: { lect: { email_status: 'verified' } } }]);
  });
});

describe('reports', () => {
  it('tiers contacts by direct contact methods', async () => {
    fakeCms([
      ADA,   // phone + email + social → tier 1
      GRACE, // general phone only → tier 4
      contact(31, 'Emmy Noether', { email: [{ email: 'emmy@example.com' }] }), // tier 3
      contact(32, 'Nameless', {}), // tier 5
    ]);
    const response = await plugin.fetch(request('/__plugin/admin/reports'), env());
    const html = await renderedText(response);

    expect(html).toContain('Tier 1 — Phone + email + social media');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('4 contacts');
  });
});
