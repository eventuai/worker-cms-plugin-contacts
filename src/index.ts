// ============================================================
// Worker CMS plugin — "contacts" (CRM).
//
// Implements the CMS plugin contract over the reserved /__plugin/* prefix.
// Registers the `contact` content type (blueprint + taxonomies) so contacts
// are authored as CMS pages, and serves an admin UI (list / import / search)
// proxied at /admin/plugins/contacts/*.
//
// Blueprint ported from the legacy Eventuai app:
//   eventuai/admin/application/config/cms.mjs → blueprint.contact + tagLists.contact
//
// Bind into the CMS as a service binding (PLUGIN_CONTACTS) and list it in the
// CMS `PLUGINS` var. See cms-to-rsvp.md.
// ============================================================

interface PluginEnv {
  /** Shared secret the CMS forwards on every privileged call. */
  PLUGIN_SECRET?: string;
}

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

// ── Content types ────────────────────────────────────────────────────────────
// `@field`  = attribute (meta/hidden-ish field)
// `name:type` = field `name` rendered by field-type `type` (falls back to a
//               text/textarea input in the CMS editor when no snippet exists)
// `{ group: [...] }` = repeatable nested item list
const CONTACT_BLUEPRINT: BlueprintEntry[] = [
  '@id', '@source', '@updated_at', '@gender', '@prefix', '@suffix', '@region',
  '@nationality', '@prefer_language', '@birthday', '@referral_by', '@remarks',
  '@optout_mobile', '@optout_email',

  'first_name', 'middle_name', 'last_name', 'full_name', 'family_business',
  'bio:richtext/md',

  { nickname: ['@name'] },
  { spouse: ['@email', '@phone:phone', 'name'] },
  {
    position: [
      '@type', 'client', '@website', '@direct_phone:phone', '@general_phone:phone',
      '@direct_phone_ext', '@fax:phone', '@email:email', '@general_email:email',
      'organization_name', 'department', 'title', 'address',
    ],
  },
  { home: ['@phone:phone', 'address'] },
  { other_address: ['address'] },
  { email: ['@type', '@email:email'] },
  { phone: ['@type', '@phone:phone'] },
  { assistant: ['@email:email', '@mobile:phone', '@work_phone:phone', 'name'] },
  { social_media: ['@type', '@url'] },
  {
    event_history: ['@date', '@event_name', '@role', '@session', '@rsvp', '@group_rsvp', '@remark'],
  },
];

const CONTACT_TAXONOMIES = [
  'Contact Type', 'Industry', 'Interest', 'Food Allergies',
  'Email Status', 'Phone Status', 'Event',
];

const MANIFEST = {
  id: 'contacts',
  name: 'Contacts',
  version: '0.1.0',
  nav: [{ label: 'Contacts', href: 'dashboard', roles: ['admin', 'editor'] }],
  contentTypes: {
    blueprint: { contact: CONTACT_BLUEPRINT },
    taxonomyLists: { contact: CONTACT_TAXONOMIES },
  },
};

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

    if (path.startsWith('/__plugin/admin')) {
      const user = parseUser(request.headers.get('x-cms-user'));
      return html(adminDashboard(user));
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

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function adminDashboard(user: { name?: string; role?: string }): string {
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Contacts</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-3xl mx-auto space-y-6">
    <div class="bg-white rounded-xl shadow p-6">
      <h1 class="text-2xl font-bold text-gray-900 mb-1">Contacts</h1>
      <p class="text-gray-600 mb-4">Hello, ${name}. The <code>contact</code> content type is registered.</p>
      <div class="flex gap-3">
        <a href="/admin/pages/new?page_type=contact"
           class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New contact</a>
        <a href="/admin/pages?page_type=contact"
           class="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700">All contacts</a>
      </div>
    </div>
    <div class="bg-white rounded-xl shadow p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">Status</h2>
      <ul class="text-sm text-gray-700 space-y-1">
        <li>✅ <b>contact</b> blueprint registered (names, positions, emails, phones, assistants, social, event history)</li>
        <li>✅ contact taxonomies: ${CONTACT_TAXONOMIES.join(', ')}</li>
        <li>⬜ Import (Excel / CSV / VCF) — needs CMS plugin-write API (F1) + R2 staging</li>
        <li>⬜ Advanced search + export, duplicate detection</li>
        <li>⬜ Contact typeahead API (HX equivalent)</li>
      </ul>
    </div>
  </div>
</body>
</html>`;
}
