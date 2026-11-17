
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
