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
- **Nav (3 items):** Contacts, Email Quality, Contact Reports — sections of the
  same plugin admin.

## Admin sections

- **Contacts** (`/admin/plugins/contacts/contacts`) — list + search (Plugin API `q`
  over names/emails/organizations), CSV export of the current search,
  export-sample, and **CSV/VCF import** with a preview → confirm flow
  (`src/import.ts`): rows match an existing contact by legacy `contact_id` →
  any email → full-name key (consumed once, so re-imports are idempotent);
  creates run in 25-row Plugin API batches, updates per contact. Excel files aren't
  parsed — convert to CSV first. Taxonomy-tag columns are skipped (Plugin API has no
  tag-name resolution yet). Authoring stays in the CMS page editor.
- **JSON endpoints** — `contacts/check-duplicate.json?email=&name=` (legacy
  check_duplicate) and `contacts/search.json?q=` (typeahead; the events
  plugin's add-from-contacts page can call it same-origin via the admin proxy).
- **Email Quality** (`…/email-quality`) — status counts, unverified list,
  per-email search, manual status set, and a batch **submit-to-verifier**
  (generic `POST {emails:[…]}` with a bearer key). Status lives on the contact
  page as the `email_status` attr; a syntax heuristic (same split the events
  plugin's auto-send uses) is shown as a hint.
- **Contact Reports** (`…/reports`) — the legacy contact-quality tier analysis
  (direct phone/email/social → tiers 1–3, company-level only → 4, unreachable
  → 5). The legacy *user-usage* report is not ported: it reads the CMS audit
  tables, which the plugin API doesn't expose.

## Develop

```bash
npm install
npm run dev          # wrangler dev
npm run typecheck
npm test
npm run deploy
```

## Register into the CMS (D1 URL transport — no service binding)

1. `wrangler deploy` this Worker, then `wrangler secret put PLUGIN_SECRET`.
   (For email verification also: `wrangler secret put VERIFIER_API_KEY` and set
   `VERIFIER_API_URL` in `wrangler.toml`.)
2. In the CMS: **Admin → Plugins → Register plugin**, paste this Worker's base URL.
   (Requires `plugin:manage` and the same `PLUGIN_SECRET` on the CMS.)

No `wrangler.toml` change or CMS redeploy needed.

## Status

- [x] `contact` blueprint + taxonomies; 3-section admin
- [x] List + search + CSV export/export-sample
- [x] CSV/VCF import (preview → confirm, idempotent re-import); XLSX = convert first
- [x] Duplicate detection + typeahead JSON
- [x] Email quality (heuristic + external verifier + manual statuses)
- [x] Contact-quality tier report
- [ ] Taxonomy-tag import/assignment (needs Plugin API tag-name resolution)
- [ ] User-usage report (needs host audit access)

## Source mapping (legacy → here)

`controller/admin/{Contact,ContactAPI,EmailQuality}.mjs`, `helper/Importer.mjs`,
`helper/{Contact,ExcelParser,VcfParser,JSONSearch,EmailQuality}.mjs`,
`importer/Contact.mjs`.
