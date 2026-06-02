export type Role = 'user' | 'admin';

const allRoles: Record<Role, string[]> = {
  user: ['user', 'common'],
  admin: ['admin', 'common'],
};

const Roles = Object.keys(allRoles) as Array<keyof typeof allRoles>;

// Map the roles to their corresponding rights
const roleRights = new Map<Role, string[]>(
  Object.entries(allRoles) as [Role, string[]][]
);

export { Roles, roleRights };
