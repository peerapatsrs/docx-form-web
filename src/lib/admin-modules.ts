/**
 * Admin console module registry.
 * Dev: add a row here + create `src/app/admin/<id>/page.tsx` (and set status: "live").
 */

export type AdminModuleStatus = "live" | "planned";

export type AdminModule = {
  /** URL segment under /admin — use "" for overview */
  id: string;
  href: string;
  title: string;
  description: string;
  /** Nav group label */
  group: "ทั่วไป" | "สมาชิก" | "ระบบ";
  status: AdminModuleStatus;
};

export const ADMIN_MODULES: AdminModule[] = [
  {
    id: "",
    href: "/admin",
    title: "ภาพรวม",
    description: "สถานะระบบและทางลัดไปโมดูลจัดการ",
    group: "ทั่วไป",
    status: "live",
  },
  {
    id: "billing",
    href: "/admin/billing",
    title: "แผน / จ่ายแล้ว",
    description: "ติ๊กผู้ใช้ที่เป็นสมาชิกจ่ายแล้วก่อนต่อ Stripe",
    group: "สมาชิก",
    status: "live",
  },
  {
    id: "users",
    href: "/admin/users",
    title: "ผู้ใช้ & บทบาท",
    description: "ค้นหา แบน เปลี่ยน role",
    group: "สมาชิก",
    status: "live",
  },
  {
    id: "limits",
    href: "/admin/limits",
    title: "โควตา & ลิมิต",
    description: "จำนวนไฟล์ต่อครั้งของฟรี / จ่ายแล้ว",
    group: "ระบบ",
    status: "live",
  },
  {
    id: "ai",
    href: "/admin/ai",
    title: "AI",
    description: "โมเดลเริ่มต้นและสถานะคีย์เซิร์ฟเวอร์",
    group: "ระบบ",
    status: "live",
  },
  {
    id: "audit",
    href: "/admin/audit",
    title: "บันทึกการใช้งาน",
    description: "ประวัติการกระทำของแอดมิน",
    group: "ระบบ",
    status: "live",
  },
];

export function adminModulesByGroup(): { group: string; modules: AdminModule[] }[] {
  const order: AdminModule["group"][] = ["ทั่วไป", "สมาชิก", "ระบบ"];
  return order.map((group) => ({
    group,
    modules: ADMIN_MODULES.filter((m) => m.group === group),
  }));
}

export function findAdminModule(pathname: string): AdminModule | undefined {
  const normalized = pathname.replace(/\/$/, "") || "/admin";
  return (
    ADMIN_MODULES.find((m) => m.href === normalized) ||
    ADMIN_MODULES.find((m) => m.href !== "/admin" && normalized.startsWith(m.href))
  );
}
