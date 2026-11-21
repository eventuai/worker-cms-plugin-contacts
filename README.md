
## Primary email for eDM

Each contact row shows its effective eDM email and badge. Users with
`contacts:update` can use the **Primary email for eDM** selector and Save button
in that row. Choices include personal, work, general work and assistant email;
spouse addresses are excluded. **Automatic** clears the preference. Removed or
stale selections fall back to the first eligible address in that order. The
same preference is used by contact rows/typeahead, verifier submission and the
events plugin's contact-to-guest copy/refresh.

The preference is `lect.primary_email`, declared in the contact blueprint. It
is changed with a partial CMS update, preserving other contact fields. Existing
guest snapshots are refreshed explicitly in events. Refresh both plugin
manifests after deployment to expose the new fields; no new JS approval is needed.

## Legacy duplicate checks and search navigation

`check-duplicate.json?email=&name=` pages through the complete CMS search candidate set rather than stopping after 50 candidates, then checks exact normalized email/name values. The inventory includes personal, work, general, assistant and spouse addresses; shared addresses can identify multiple contacts. eDM recipient selection and assistant-only CC remain separate from this inventory.

Contacts links to the host's contact-scoped advanced search, preserving the current search term. The host controls search permissions and feature availability and shows CSV export when the import-export plugin is enabled; the contacts plugin does not duplicate those engines.

## Per-email verification and verifier reports

Email quality now lives in private draft `email_quality` pages, keyed by a SHA-256 slug of the normalized address. One address has one result shared across contacts; two addresses on the same contact can have different outcomes. Legacy contact-wide `email_status` remains a fallback for the current effective primary address, and the old status POST without an email retains its existing behavior.

Email Quality → **Import verifier CSV** previews `email` (preferred over a person's `name`), `quality`, `result`, `free`, `source`, and `contact_id`. BOM/whitespace headers and legacy name-as-email files work. Scores map good/ok to 100, risky/unknown to 50, bad/invalid to 0. Conflicting duplicates and invalid scores/addresses fail before writes. Missing metadata stays unchanged; explicit blank values clear it. Reports may include addresses without a contact. Search by the exact email to inspect those records. Files are limited to 10 MB / 1,000 addresses; confirmation applies at most 20 writes per pass with an idempotent Continue import action.

Manual status changes on the quality screen apply to that address. Verifier submissions cover personal, work, general, assistant and spouse addresses on the current 100-contact page, deduplicate addresses, submit at most 20 unverified addresses per request and save omitted responses as pending. Repeat for remaining addresses and navigate to the next contact page. Contact rows show the effective address's stored status.

Refresh the Contacts manifest after deployment to register the new type. Refresh the Events manifest and approve its `email_quality` read delegation to show verification badges and use verified/invalid/risky results in its auto-send groups. No quality records are auto-published and no new JavaScript asset is required.
