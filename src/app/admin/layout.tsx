import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { requireServerSuperAdmin } from "@/lib/server-auth";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireServerSuperAdmin("/admin");
  return <AdminShell>{children}</AdminShell>;
}
