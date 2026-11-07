// CRUD gating over the plugin's own permissions (declared in manifest.json):
// contacts:read / contacts:create / contacts:update / contacts:delete, applied
// to both contacts and organizations. The host forwards the signed-in user's
// granted ones in x-cms-user.permissions (admins receive all of them). Any
// write permission implies read, since every write screen shows existing
// records. Secret-authenticated calls without a user header (tests, tooling)
// are trusted.

import { parseCmsUser } from '@lionrockjs/worker-cms-plugin';

export const PERMISSIONS = {
  read: 'contacts:read',
  create: 'contacts:create',
  update: 'contacts:update',
  delete: 'contacts:delete',
} as const;

export interface ContactsAccess {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

const FULL_ACCESS: ContactsAccess = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

export function contactsAccessForRequest(request: Request): ContactsAccess {
  const header = request.headers.get('x-cms-user');
  const user = parseCmsUser(header);
  const roles = (user.role ?? '').split(',').map((role) => role.trim().toLowerCase()).filter(Boolean);
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
  if (!roles.length && !permissions.length) return { ...FULL_ACCESS };
  if (roles.includes('admin')) return { ...FULL_ACCESS };
  const canCreate = permissions.includes(PERMISSIONS.create);
  const canUpdate = permissions.includes(PERMISSIONS.update);
  const canDelete = permissions.includes(PERMISSIONS.delete);
  return {
    canRead: canCreate || canUpdate || canDelete || permissions.includes(PERMISSIONS.read),
    canCreate,
    canUpdate,
    canDelete,
  };
}

export function forbidden(): Response {
  return new Response('forbidden', { status: 403 });
}
