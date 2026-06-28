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
import { clientViewResponse, parseCmsUser, requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';

interface PluginEnv {
  PLUGIN_SECRET?: string;
  /** External email-verification API key (wrangler secret put). */
  VERIFIER_API_KEY?: string;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
}

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin');
    if (secretRequired) {
      const forbidden = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (forbidden) return forbidden;
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    if (path.startsWith('/__plugin/admin')) {
      const rest = path.replace(/^\/__plugin\/admin\/?/, '');
      const segments = rest.split('/').filter(Boolean);
      if (segments[0] === 'views') {
        const viewPath = `/${segments.slice(1).join('/')}`;
        return serveViewAsset(env.VIEWS, viewPath);
      }
      const user = parseCmsUser(request.headers.get('x-cms-user'));
      const section = segments[0] || 'contacts';
      return adminShell(section, user);
    }

    return new Response('not found', { status: 404 });
  },
};

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

  return clientViewResponse(meta.title, '/templates/contacts-admin.json', payload);
}
