import { adminView } from '@lionrockjs/worker-cms-plugin';
import { type CmsClient, type CmsPage } from './cms';
import { qualityEmail, qualitySlug, qualityStatus, readEmailQuality, type QualityInput } from './email-quality-records';
export class QualityImportError extends Error {}
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value); if (row.some(v => v.trim())) rows.push(row); row = []; value = '';
    } else value += c;
  }
  if (quoted) throw new QualityImportError('Unclosed quoted CSV field.');
  row.push(value); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
export function parseQualityReport(csv: string): QualityInput[] {
  if (new TextEncoder().encode(csv).byteLength > 10 * 1024 * 1024) throw new QualityImportError('Quality reports are limited to 10 MB.');
  const [rawHeaders = [], ...rows] = csvRows(csv);
  const headers = rawHeaders.map(v => v.replace(/^\uFEFF/, '').trim().toLowerCase());
  const emailIndex = headers.includes('email') ? headers.indexOf('email') : headers.indexOf('name');
  if (emailIndex < 0) throw new QualityImportError('CSV needs an email column (or legacy name-as-email).');
  if (rows.length > 1000) throw new QualityImportError('Split reports into at most 1,000 addresses.');
  const output = new Map<string, QualityInput>();
  for (const row of rows) {
    const email = qualityEmail(row[emailIndex]); if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new QualityImportError(`Invalid email: ${email}`);
    const input: QualityInput = { email };
    for (const key of ['quality', 'result', 'free', 'source', 'contact_id'] as const) {
      const index = headers.indexOf(key); if (index >= 0) input[key] = (row[index] ?? '').trim();
    }
    if (input.quality !== undefined) {
      const aliases: Record<string, string> = { good: '100', ok: '100', risky: '50', unknown: '50', bad: '0', invalid: '0' };
      input.quality = aliases[input.quality.toLowerCase()] ?? input.quality;
      if (input.quality !== '' && (!/^\d+(?:\.\d+)?$/.test(input.quality) || Number(input.quality) > 100)) throw new QualityImportError(`Invalid quality for ${email}. Use 0–100 or good/ok/risky/unknown/bad/invalid.`);
      input.status = qualityStatus({ quality: input.quality });
    }
    const prior = output.get(email);
    if (prior && JSON.stringify(prior) !== JSON.stringify(input)) throw new QualityImportError(`Conflicting report rows for ${email}.`);
    output.set(email, input);
  }
  if (!output.size) throw new QualityImportError('No email addresses found.');
  return [...output.values()];
}
export async function saveQuality(cms: CmsClient, input: QualityInput, existing?: CmsPage): Promise<boolean> {
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'email'));
  if (existing && Object.entries(fields).every(([key, value]) => String(existing.lect[key] ?? '') === value)) return false;
  const lect = { ...fields, email: input.email, checked_at: new Date().toISOString() };
  if (existing) await cms.update(existing.id, { lect });
  else await cms.create({ page_type: 'email_quality', name: input.email, slug: await qualitySlug(input.email), lect });
  return true;
}
export async function qualityImport(request: Request, cms: CmsClient, views: Fetcher, confirm: boolean, jsonOnly = false): Promise<Response> {
  if (request.method !== 'POST') return adminView(views, 'Import verifier results', 'quality-import', { action: '/admin/plugins/contacts/email-quality/import' }, jsonOnly);
  const form = await request.formData(); const file = form.get('file');
  if (file instanceof File && file.size > 10 * 1024 * 1024) throw new QualityImportError('Quality reports are limited to 10 MB.');
  const csv = file instanceof File && file.size ? await file.text() : String(form.get('csv') || '');
  const rows = parseQualityReport(csv);
  const records = await readEmailQuality(cms, rows.map(row => row.email), false);
  if (!confirm) return adminView(views, 'Review verifier results', 'quality-import', { confirm: true, csv, rows: rows.map(row => ({ ...row, status: row.status || '', previous: records.get(row.email) ? qualityStatus(records.get(row.email)!.lect) : '', exists: records.has(row.email) })), action: '/admin/plugins/contacts/email-quality/import/confirm' }, jsonOnly);
  // Reclassification on every pass is idempotent; at most 20 writes leaves headroom for report lookups.
  let writes = 0; let remaining = false;
  for (const row of rows) {
    const existing = records.get(row.email);
    const fields = Object.entries(row).filter(([key]) => key !== 'email');
    if (existing && fields.every(([key, value]) => String(existing.lect[key] ?? '') === value)) continue;
    if (writes >= 20) { remaining = true; break; }
    try { if (await saveQuality(cms, row, existing)) writes++; }
    catch (error) { if (!/too many subrequests/i.test(error instanceof Error ? error.message : String(error))) throw error; remaining = true; break; }
  }
  if (!remaining) return new Response(null, { status: 303, headers: { Location: '/admin/plugins/contacts/email-quality?flash=Verifier+results+imported' } });
  return adminView(views, 'Continue verifier import', 'quality-import', { progress: true, csv, writes, action: '/admin/plugins/contacts/email-quality/import/confirm' }, jsonOnly);
}
