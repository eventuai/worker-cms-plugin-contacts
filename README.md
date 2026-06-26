# worker-cms-plugin-contacts (Contacts Suite)

A [Worker CMS](https://github.com/zeroxcms) plugin covering the **contact side**
of the system in one Worker — **contacts / CRM + email quality** — to stay within
the Cloudflare **Free plan** (50 subrequests/request, 100k requests/day).

Part of the RSVP/contact port — see `cms/../cms-to-rsvp.md`. Pairs with
`cms-plugin-events` (the other suite). Replaces the former standalone
`cms-plugin-email-quality` repo.

## Registers (manifest id `contacts`)

- **Blueprint:** `contact` — multilingual names, 5 work positions, multiple
  emails/phones, 5 assistants, 8 social platforms, spouse, addresses,
  `event_history`.
- **Taxonomies:** Contact Type, Industry, Interest, Food Allergies, Email
  Status, Phone Status, Event.
- **Nav (2 items):** Contacts, Email Quality — sections of the same plugin admin.

## Develop

```bash
npm install
npm run dev          # wrangler dev
npm run typecheck
npm run deploy
```

## Register into the CMS (D1 URL transport — no service binding)

1. `wrangler deploy` this Worker, then `wrangler secret put PLUGIN_SECRET`.
   (For email verification also: `wrangler secret put VERIFIER_API_KEY`.)
2. In the CMS: **Admin → Plugins → Register plugin**, paste this Worker's base URL.
   (Requires `plugin:manage` and the same `PLUGIN_SECRET` on the CMS.)

No `wrangler.toml` change or CMS redeploy needed.

Plugin admin pages run on this Worker's origin inside a CMS sandboxed iframe.
The CMS appends a short-lived `cms_launch` token to the iframe URL; this Worker
validates it with `PLUGIN_SECRET` and sets an iframe-origin admin session cookie.
Hooks and publish calls still use `x-plugin-secret`.

## Status

- [x] `contact` blueprint + taxonomies; 2-section admin (Contacts / Email Quality)
- [ ] Import (Excel / CSV / VCF) — needs CMS plugin-write API (F1) + R2 staging
- [ ] Advanced search + export, duplicate detection, typeahead API
- [ ] Email verification: search / unverified list / submit-to-verifier

## Source mapping (legacy → here)

`controller/admin/{Contact,ContactAPI,EmailQuality}.mjs`, `helper/Importer.mjs`,
`helper/{Contact,ExcelParser,VcfParser,JSONSearch,EmailQuality}.mjs`,
`importer/Contact.mjs`.
