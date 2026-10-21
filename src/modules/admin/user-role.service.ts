import { User, ROLES, type Role } from "../identity/models/User.js";
import { AppError } from "../../shared/errors/index.js";
import { sendOpsAlert } from "../../infra/monitoring/ops-alert.js";

export type RoleChange = { id: string; email: string; role: Role; previousRole: Role };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export async function changeUserRole(requesterId: string, targetId: string, role: Role): Promise<RoleChange> {
  if (targetId === requesterId) throw new AppError(400, "You can't change your own role");

  const target = await User.findById(targetId).select("email role");
  if (!target) throw new AppError(404, "user not found");

  const previousRole = target.role as Role;
  if (previousRole === role) return { id: target.id, email: target.email, role, previousRole };

  if (previousRole === "super_admin") {
    const superAdmins = await User.countDocuments({ role: "super_admin" });
    if (superAdmins <= 1) throw new AppError(400, "There must always be at least one super admin");
  }

  target.role = role;
  await target.save();

  if (role === "super_admin" || previousRole === "super_admin") {
    await sendOpsAlert({
      title: role === "super_admin" ? "Super admin added" : "Super admin removed",
      where: "admin users",
      detail: `${target.email}: ${previousRole} → ${role}`,
    });
  }

  return { id: target.id, email: target.email, role, previousRole };
}
