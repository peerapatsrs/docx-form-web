import type { ReactNode } from "react";
import { requireServerUser } from "@/lib/server-auth";

export default async function AccountLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireServerUser("/account");
  return children;
}
