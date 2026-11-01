import type { ReactNode } from "react";
import { redirectIfAuthenticated } from "@/lib/server-auth";

export default async function LoginLayout({
  children,
}: {
  children: ReactNode;
}) {
  await redirectIfAuthenticated("/");
  return children;
}
