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
import { ADMIN_BASE, checkDuplicate, contactsIndex, exportContacts, exportSample, searchJson } from './contacts';
import { emailQualityIndex, setEmailStatus, submitToVerifier, type VerifierEnv } from './email-quality';
import { confirmImport, importForm, previewImport } from './import';
import { contactQualityReport } from './reports';
import { contactsAccessForRequest, forbidden } from './permissions';
import { adminView, requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';

interface PluginEnv extends VerifierEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (for the Plugin API page read/write API). */
  CMS_URL?: string;
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
      const forbiddenResponse = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (forbiddenResponse) return forbiddenResponse;
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
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

  const access = contactsAccessForRequest(request);
  if (!access.canView) return forbidden();
  const jsonOnly = wantsJson(url);
  const cms = new CmsClient(env);
  const section = segments[0] || 'contacts';

  if (section === 'contacts') {
    const sub = segments[1] ?? '';
    if (!sub) return contactsIndex(cms, env.VIEWS, url, jsonOnly);
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

  return contactsIndex(cms, env.VIEWS, new URL(`${url.origin}${ADMIN_BASE}/contacts`), jsonOnly);
}

function wantsJson(url: URL): boolean {
  const format = url.searchParams.get('format');
  const json = url.searchParams.get('json');
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}
