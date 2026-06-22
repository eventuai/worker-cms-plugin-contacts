# worker-cms-plugin-contacts

A [Worker CMS](https://github.com/zeroxcms) plugin that adds a **contacts / CRM**
domain. It registers the `contact` content type so contacts are authored as CMS
pages, and (planned) provides import, advanced search and dedupe tooling.

Part of the RSVP/contact port — see `cms/../cms-to-rsvp.md`.

## Registers

- **Blueprint:** `contact` — multilingual names, 5 work positions, multiple
  emails/phones, 5 assistants, 8 social platforms, spouse, addresses,
  `event_history` (ported from the legacy `config/cms.mjs`).
- **Taxonomies:** Contact Type, Industry, Interest, Food Allergies, Email
  Status, Phone Status, Event.
- **Nav + admin page** proxied at `/admin/plugins/contacts/*`.

## Develop

```bash
npm install
npm run dev          # wrangler dev
npm run typecheck
npm run deploy
```

## Bind into the CMS

```toml
# CMS wrangler.toml
[[services]]
binding = "PLUGIN_CONTACTS"
service = "cms-plugin-contacts"

[vars]
PLUGINS = "PLUGIN_CONTACTS"   # add to the comma-separated list
```

Share the secret with both Workers: `wrangler secret put PLUGIN_SECRET`.

## Status

- [x] `contact` blueprint + taxonomies registered
- [x] Admin dashboard
- [ ] Import (Excel / CSV / VCF) — needs CMS plugin-write API (F1) + R2 staging
- [ ] Advanced search + export, duplicate detection
- [ ] Contact typeahead API

## Source mapping (legacy → here)

`controller/admin/Contact.mjs`, `ContactAPI.mjs`, `helper/Importer.mjs`,
`helper/{Contact,ExcelParser,VcfParser,JSONSearch}.mjs`, `importer/Contact.mjs`.
