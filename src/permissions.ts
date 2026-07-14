// Role gating mirroring the events plugin's model: admins/editors get full
// access; other signed-in users need contacts:view / contacts:write
// permissions forwarded in x-cms-user. Secret-authenticated calls without a
// user header (tests, tooling) are trusted.

import { parseCmsUser } from '@lionrockjs/worker-cms-plugin';

export interface ContactsAccess {
  canView: boolean;
  canEdit: boolean;
}

export function contactsAccessForRequest(request: Request): ContactsAccess {
  const header = request.headers.get('x-cms-user');
  const user = parseCmsUser(header);
  const role = user.role ?? '';
  // parseCmsUser only keeps id/email/name/role — read the permissions array
  // straight from the header.
  let permissions: string[] = [];
  try {
    const parsed = JSON.parse(header ?? '') as { permissions?: unknown };
    if (Array.isArray(parsed.permissions)) {
      permissions = parsed.permissions.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // No / malformed user header — handled by the trusted-call branch below.
  }
  if (!role && !permissions.length) return { canView: true, canEdit: true };
  if (role === 'admin' || role === 'editor') return { canView: true, canEdit: true };
  const canEdit = permissions.includes('contacts:write');
  return { canView: canEdit || permissions.includes('contacts:view'), canEdit };
}

export function forbidden(): Response {
  return new Response('forbidden', { status: 403 });
}
