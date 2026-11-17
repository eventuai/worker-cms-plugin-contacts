import { CmsClient, contactEmails, contactNameKey, type CmsPage } from './cms';

/** Audit/identity inventory includes related addresses; recipient eligibility is separate. */
export async function duplicateContacts(cms: CmsClient, email: string, name: string): Promise<CmsPage[]> {
  const matches = new Map<number, CmsPage>();
  for (const term of new Set([email, name].filter(Boolean))) {
    let offset = 0;
    for (;;) {
      const { pages, total } = await cms.list('contact', { q: term, limit: 500, offset });
      for (const page of pages) {
        if ((email && contactEmails(page.lect).includes(email)) || (name && contactNameKey(page) === name)) matches.set(page.id, page);
      }
      offset += pages.length;
      if (!pages.length || offset >= total) break;
    }
  }
  return [...matches.values()];
}
