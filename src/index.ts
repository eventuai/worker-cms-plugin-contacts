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
    if (secretRequired && env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
      return new Response('forbidden', { status: 403 });
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

  return clientViewResponse(meta.title, '/templates/contacts-admin.json', payload);
}

function clientViewResponse(title: string, viewPath: string, data: Record<string, unknown>): Response {
  return Response.json(data, {
    headers: {
      'x-cms-chrome': '1',
      'x-cms-client-view': '1',
      'x-cms-view-path': viewPath,
      // Encoded so non-ASCII titles stay header-safe; the CMS proxy decodes it.
      'x-cms-title': encodeURIComponent(title),
    },
  });
}

async function serveViewAsset(views: Fetcher, assetPath: string): Promise<Response> {
  if (!assetPath.startsWith('/') || assetPath.includes('..')) return new Response('not found', { status: 404 });
  const response = await views.fetch(new URL(assetPath, 'https://views.local'));
  if (!response.ok) return new Response('not found', { status: 404 });

  const headers = new Headers(response.headers);
  if (assetPath.endsWith('.js')) {
    headers.set('content-type', 'text/javascript; charset=utf-8');
  } else if (assetPath.endsWith('.json')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  } else if (assetPath.endsWith('.liquid')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  if (assetPath.startsWith('/assets/')) {
    headers.set('cache-control', 'public, max-age=86400');
  } else if (assetPath.endsWith('.json') || assetPath.endsWith('.liquid')) {
    headers.set('cache-control', 'private, max-age=86400');
  } else {
    headers.set('cache-control', 'no-store');
  }
  return new Response(response.body, { status: response.status, headers });
}
