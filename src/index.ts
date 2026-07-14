// ============================================================
// Worker CMS plugin — "contacts" suite (CRM + email quality + reports).
//
// One Worker for the whole contact side of the system, to stay within the
// Cloudflare Free plan's per-request subrequest cap (50) and daily request
// budget (100k). Registers the `contact` content type (blueprint + taxonomies)
// so contacts are authored as CMS pages through the CMS editor; this plugin
// adds the surrounding machinery the generic editor doesn't have:
//
//   contacts       — list + search, CSV export (+ sample), CSV/VCF import
//                    (preview → confirm), duplicate check, typeahead JSON
//   email-quality  — verification status over every contact's emails
//   reports        — contact-quality tier analysis
//
// Ported from the legacy Eventuai app: controller/admin/Contact.mjs,
// ContactAPI.mjs, EmailQuality.mjs, Report.mjs, helper/Importer.mjs.
// ============================================================

import MANIFEST from './manifest.json';
import { CmsClient, CmsApiError, CmsNotConfiguredError } from './cms';
import { ADMIN_BASE, bulkDeleteContacts, checkDuplicate, contactsIndex, exportContacts, exportSample, searchJson } from './contacts';
import { emailQualityIndex, setEmailStatus, submitToVerifier, type VerifierEnv } from './email-quality';
import { confirmImport, importForm, previewImport } from './import';
import { contactQualityReport } from './reports';
import { contactsAccessForRequest, forbidden } from './permissions';
import { adminView, requireTenant, serveViewAsset, tenantClientEnv } from '@lionrockjs/worker-cms-plugin';

interface PluginEnv extends VerifierEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the Plugin API page read/write API). */
  CMS_URL?: string;
  /** Multi-tenant registry: `tenant:<cms origin>` → TenantConfig JSON. When
   *  unbound, CMS_URL + PLUGIN_SECRET form the single legacy tenant. */
  TENANTS?: KVNamespace;
  /** Plugin-owned Liquid templates and other view assets. */
  VIEWS: Fetcher;
}

export default {
  async fetch(request: Request, baseEnv: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Secret-authenticated host calls resolve their tenant; downstream code
    // then runs against a tenant-scoped env, so every CmsClient built from
    // `env` is bound to the calling CMS only.
    let env = baseEnv;
    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin');
    if (secretRequired) {
      const tenant = await requireTenant(request, baseEnv);
      if (tenant instanceof Response) return tenant;
      env = tenantClientEnv(baseEnv, tenant);
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    // Static assets declared in the plugin manifest. The CMS fetches these at
    // this bare path — both when an admin approves one (hash pinning) and on
    // every proxied serve — before allowing them to run under CMS chrome.
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      try {
        return await handleAdmin(request, env, url);
      } catch (error) {
        if (error instanceof CmsNotConfiguredError) {
          return adminView(env.VIEWS, 'Contacts', 'error', {
            heading: 'CMS link not configured',
            message: 'Set CMS_URL and PLUGIN_SECRET so the plugin can reach the CMS page API.',
          });
        }
        if (error instanceof CmsApiError) {
          return adminView(env.VIEWS, 'Contacts', 'error', {
            heading: `CMS responded ${error.status}`,
            message: error.message,
          });
        }
        throw error;
      }
    }

    return new Response('not found', { status: 404 });
  },
};

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  if (segments[0] === 'views') {
    return serveViewAsset(env.VIEWS, `/${segments.slice(1).join('/')}`);
  }
  if (segments[0] === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }

  const access = contactsAccessForRequest(request);
  if (!access.canView) return forbidden();
  const jsonOnly = wantsJson(url);
  const cms = new CmsClient(env);
  const section = segments[0] || 'contacts';

  if (section === 'contacts') {
    const sub = segments[1] ?? '';
    if (!sub) return contactsIndex(cms, env.VIEWS, url, jsonOnly, access.canEdit);
    if (sub === 'bulk-delete' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return bulkDeleteContacts(request, cms);
    }
    if (sub === 'export') return exportContacts(cms, url);
    if (sub === 'export-sample') return exportSample();
    if (sub === 'check-duplicate.json') return checkDuplicate(cms, url);
    if (sub === 'search.json') return searchJson(cms, url);
    if (sub === 'import') {
      if (!access.canEdit) return forbidden();
      if (segments[2] === 'confirm' && request.method === 'POST') return confirmImport(request, cms);
      if (request.method === 'POST') return previewImport(request, cms, env.VIEWS, jsonOnly);
      return importForm(env.VIEWS, jsonOnly);
    }
  }

  if (section === 'email-quality') {
    if (segments[1] === 'status' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return setEmailStatus(request, cms);
    }
    if (segments[1] === 'submit' && request.method === 'POST') {
      if (!access.canEdit) return forbidden();
      return submitToVerifier(cms, env);
    }
    return emailQualityIndex(cms, env.VIEWS, env, url, jsonOnly);
  }

  if (section === 'reports') {
    return contactQualityReport(cms, env.VIEWS, jsonOnly);
  }

  return contactsIndex(cms, env.VIEWS, new URL(`${url.origin}${ADMIN_BASE}/contacts`), jsonOnly, access.canEdit);
}

function wantsJson(url: URL): boolean {
  const format = url.searchParams.get('format');
  const json = url.searchParams.get('json');
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}
