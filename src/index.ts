// ============================================================
// Worker CMS plugin — "contacts" suite (CRM + email quality).
//
// One Worker for the whole contact side of the system, to stay within the
// Cloudflare Free plan's per-request subrequest cap (50) and daily request
// budget (100k): contacts/CRM + email verification.
//
// Registers the `contact` content type (blueprint + taxonomies) so contacts are
// authored as CMS pages, and exposes two admin nav items (Contacts / Email
// Quality) under a single manifest id.
//
// Ported from the legacy Eventuai app: config/cms.mjs (blueprint.contact +
// tagLists.contact), controller/admin/EmailQuality.mjs.
// ============================================================

// The plugin manifest (content types, blueprint, taxonomies, nav) is plain
// data, so it lives as a static JSON file served verbatim at /__plugin/manifest
// rather than being assembled from constants here.
import MANIFEST from './manifest.json';

interface PluginEnv {
  PLUGIN_SECRET?: string;
  /** External email-verification API key (wrangler secret put). */
  VERIFIER_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin');
    if (secretRequired && env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/views/')) {
      return viewAsset(path.slice('/__plugin/views'.length));
    }

    if (path.startsWith('/__plugin/admin')) {
      const rest = path.replace(/^\/__plugin\/admin\/?/, '');
      const segments = rest.split('/').filter(Boolean);
      const user = parseUser(request.headers.get('x-cms-user'));
      const section = segments[0] || 'contacts';
      return adminShell(section, user);
    }

    return new Response('not found', { status: 404 });
  },
};

function parseUser(header: string | null): { name?: string; role?: string } {
  if (!header) return {};
  try {
    return JSON.parse(header) as { name?: string; role?: string };
  } catch {
    return {};
  }
}

const SECTIONS: Record<string, { title: string; intro: string; create?: boolean; status: string[] }> = {
  contacts: {
    title: 'Contacts',
    intro: 'The <code>contact</code> content type is registered.',
    create: true,
    status: [
      '✅ <b>contact</b> blueprint (names, positions, emails, phones, assistants, social, event history)',
      `✅ contact taxonomies: ${MANIFEST.contentTypes.taxonomyLists.contact.join(', ')}`,
      '⬜ Import (Excel / CSV / VCF) — needs CMS plugin-write API (F1) + R2 staging',
      '⬜ Advanced search + export, duplicate detection',
      '⬜ Contact typeahead API (HX equivalent)',
    ],
  },
  'email-quality': {
    title: 'Email Quality',
    intro: 'Email verification over the contacts you manage.',
    status: [
      '⬜ Search email status',
      '⬜ List unverified emails',
      '⬜ Submit batch to external verifier (needs VERIFIER_API_KEY)',
    ],
  },
};

function adminShell(section: string, user: { name?: string; role?: string }): Response {
  const meta = SECTIONS[section] ?? SECTIONS.contacts;
  const payload = {
    activeSection: SECTIONS[section] ? section : 'contacts',
    user: { name: user.name ?? 'there', role: user.role ?? '' },
    sections: Object.fromEntries(Object.entries(SECTIONS).map(([key, value]) => [key, {
      title: value.title,
      intro: value.intro,
      create: !!value.create,
      status: value.status,
    }])),
    sectionList: Object.entries(SECTIONS).map(([key, value]) => ({
      key,
      title: value.title,
    })),
  };

  return Response.json(payload, {
    headers: {
      'x-cms-chrome': '1',
      'x-cms-client-view': '1',
      'x-cms-view-path': '/templates/contacts-admin.json',
      'x-cms-title': encodeURIComponent(meta.title),
    },
  });
}

function viewAsset(path: string): Response {
  if (path === '/templates/contacts-admin.json') {
    return Response.json({
      sections: { main: { type: 'contacts-admin' } },
      order: ['main'],
    });
  }
  if (path === '/sections/contacts-admin.liquid') {
    return new Response(CONTACTS_ADMIN_SECTION, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response('not found', { status: 404 });
}

const CONTACTS_ADMIN_SECTION = `<div class="min-w-0 max-w-3xl space-y-6">
  <div class="flex flex-wrap gap-2">
    {% for item in sectionList %}
      <a href="/admin/plugins/contacts/{{ item.key | escape }}" class="px-3 py-1.5 rounded-lg text-sm font-semibold {% if item.key == activeSection %}bg-indigo-600 text-white{% else %}bg-white border border-gray-300 text-gray-700 hover:bg-gray-50{% endif %}">{{ item.title | escape }}</a>
    {% endfor %}
  </div>
  {% assign meta = sections[activeSection] | default: sections.contacts %}
  <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-1">{{ meta.title | escape }}</h1>
    <p class="text-gray-600">Hello, {{ user.name | escape }}. {{ meta.intro }}</p>
    {% if meta.create %}
      <div class="flex flex-wrap gap-3 mt-4">
        <a href="/admin/pages/new?page_type=contact" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New contact</a>
        <a href="/admin/pages?page_type=contact" class="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50">All contacts</a>
      </div>
    {% endif %}
  </div>
  <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
    <h2 class="text-lg font-semibold text-gray-900 mb-3">Status</h2>
    <ul class="text-sm text-gray-700 space-y-1">
      {% for item in meta.status %}<li>{{ item }}</li>{% endfor %}
    </ul>
  </div>
</div>`;
