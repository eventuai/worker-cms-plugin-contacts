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

interface PluginEnv {
  PLUGIN_SECRET?: string;
  /** External email-verification API key (wrangler secret put). */
  VERIFIER_API_KEY?: string;
}

type BlueprintEntry = string | Record<string, BlueprintEntry[]>;

const CONTACT_BLUEPRINT: BlueprintEntry[] = [
  "@id",
  "@source",
  "@updated_at",
  "@gender",
  "@prefix",
  "@suffix",
  "@region",
  "@nationality",
  "@prefer_language",
  "@birthday",
  "@referral_by",
  "@remarks",
  "@optout_mobile",
  "@optout_email",
  "@remark_file:file",
  "first_name",
  "middle_name",
  "last_name",
  "full_name",
  "family_business",
  "bio:richtext/md",
  {
    "position": [
      "@type",
      "client",
      "@website",
      "@direct_phone:phone",
      "@general_phone:phone",
      "@direct_phone_ext",
      "@fax:phone",
      "@email:email",
      "@general_email:email",
      "organization_name",
      "department",
      "title",
      "address"
    ]
  },
  {
    "email": [
      "@type",
      "@email:email"
    ]
  },
  {
    "phone": [
      "@type",
      "@phone:phone"
    ]
  },
  {
    "social_media": [
      "@type",
      "@url"
    ]
  },
  {
    "home": [
      "@phone:phone",
      "address"
    ]
  },
  {
    "other_address": [
      "address"
    ]
  },
  {
    "spouse": [
      "@email",
      "@phone:phone",
      "name"
    ]
  },
  {
    "assistant": [
      "@email:email",
      "@mobile:phone",
      "@work_phone:phone",
      "name"
    ]
  },
  {
    "nickname": [
      "@name"
    ]
  },
  {
    "event_history": [
      "@date",
      "@event_name",
      "@role",
      "@session",
      "@rsvp",
      "@group_rsvp",
      "@remark"
    ]
  }
];

const CONTACT_TAXONOMIES = [
  'Contact Type', 'Industry', 'Interest', 'Food Allergies',
  'Email Status', 'Phone Status', 'Event',
];

const MANIFEST = {
  id: 'contacts',
  name: 'Contacts Suite',
  version: '0.1.0',
  nav: [
    { label: 'Contacts', href: 'contacts', roles: ['admin', 'editor'] },
    { label: 'Email Quality', href: 'email-quality', roles: ['admin'] },
  ],
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
      const section = path.replace(/^\/__plugin\/admin\/?/, '').split('/')[0] || 'contacts';
      return html(adminDashboard(section, user));
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

const SECTIONS: Record<string, { title: string; intro: string; create?: boolean; status: string[] }> = {
  contacts: {
    title: 'Contacts',
    intro: 'The <code>contact</code> content type is registered.',
    create: true,
    status: [
      '✅ <b>contact</b> blueprint (names, positions, emails, phones, assistants, social, event history)',
      `✅ contact taxonomies: ${CONTACT_TAXONOMIES.join(', ')}`,
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

function adminDashboard(section: string, user: { name?: string; role?: string }): string {
  const meta = SECTIONS[section] ?? SECTIONS.contacts;
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  const createBtn = meta.create
    ? `<div class="flex gap-3 mt-4">
         <a href="/admin/pages/new?page_type=contact" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">New contact</a>
         <a href="/admin/pages?page_type=contact" class="px-4 py-2 rounded-lg bg-white border border-gray-300 text-sm font-semibold text-gray-700">All contacts</a>
       </div>`
    : '';
  const tabs = Object.entries(SECTIONS).map(([key, s]) =>
    `<a href="/admin/plugins/contacts/${key}" class="px-3 py-1.5 rounded-lg text-sm font-semibold ${key === section ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-300 text-gray-700'}">${s.title}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${meta.title}</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-3xl mx-auto space-y-6">
    <div class="flex gap-2">${tabs}</div>
    <div class="bg-white rounded-xl shadow p-6">
      <h1 class="text-2xl font-bold text-gray-900 mb-1">${meta.title}</h1>
      <p class="text-gray-600">Hello, ${name}. ${meta.intro}</p>
      ${createBtn}
    </div>
    <div class="bg-white rounded-xl shadow p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">Status</h2>
      <ul class="text-sm text-gray-700 space-y-1">${meta.status.map((s) => `<li>${s}</li>`).join('')}</ul>
    </div>
  </div>
</body>
</html>`;
}
