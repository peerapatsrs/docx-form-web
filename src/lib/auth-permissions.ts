import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  userAc,
} from "better-auth/plugins/admin/access";

const statement = {
  ...defaultStatements,
} as const;

export const ac = createAccessControl(statement);

export const user = ac.newRole({
  ...userAc.statements,
});

export const admin = ac.newRole({
  ...adminAc.statements,
});

/** Owner role — every admin statement, including impersonate-admins. */
export const superadmin = ac.newRole({
  ...defaultStatements,
});

export const roles = {
  user,
  admin,
  superadmin,
} as const;
