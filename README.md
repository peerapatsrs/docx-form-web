# docx-form-web

**docx-form** คือเว็บแอปสำหรับ**กรอกแบบฟอร์มเอกสาร Microsoft Word (.docx) จากเทมเพลต** โดยไม่ต้องเปิด Word บนเครื่อง

อัปโหลดไฟล์เทมเพลตที่มีตัวแปรแบบ `{{ชื่อฟิลด์}}` → ระบบสร้างฟอร์มบนเบราว์เซอร์ให้กรอก → (ทางเลือก) ใช้ AI อ่านไฟล์ต้นทางแล้วแมปค่าลงฟิลด์ → สร้าง `.docx` ที่กรอกครบแล้วดาวน์โหลด

เวอร์ชัน **Next.js** ของ [docx-form](https://github.com/peerapatsrs/docx-form) · UI + API ในโปรเจกต์เดียว · รัน Docker ได้

**ผู้พัฒนา:** Peerapat Surasing · peerapat.srs@gmail.com

---

## ระบบนี้ทำอะไร

| หน้าที่ | รายละเอียด |
|--------|------------|
| กรอกเทมเพลต Word | อ่านตัวแปรใน `.docx` แล้วแสดงเป็นฟอร์ม (ข้อความ / ตัวเลือก / รูป ฯลฯ) |
| หลายเทมเพลต | ทำงานกับหลายไฟล์พร้อมกัน โควตาตามแผนฟรี / จ่ายแล้ว |
| แท็กเกอร์ | ช่วยใส่และจัดการแท็ก `{{…}}` ในเอกสาร |
| AI แมปข้อมูล | ใช้คีย์ของผู้ใช้ (BYOK) จากผู้ให้บริการหลายเจ้า อ่านเอกสารต้นทางแล้วเติมฟิลด์ |
| ดราฟ & JSON | บันทึกทำต่อ · Import / Export ค่าเป็น JSON |
| ส่งออกเอกสาร | สร้างไฟล์เดียวหรือ ZIP หลายไฟล์ |
| บัญชี | OAuth / พาสคีย์ · แผนสมาชิก · คอนโซลแอดมิน (superadmin) |

**ไม่ใช่** โปรแกรมแก้เลย์เอาต์ Word เต็มรูปแบบ — จุดโฟกัสคือ*เติมค่าลงเทมเพลตที่มีตัวแปรแล้วได้ไฟล์พร้อมใช้*

---

## กลุ่มผู้ใช้ที่เหมาะ

- ทีมที่กรอกแบบฟอร์มเดิมซ้ำๆ จากเทมเพลตบริษัท
- คนที่อยากให้ AI ช่วยดึงข้อมูลจาก PDF/รูป/เอกสาร ไปลงฟอร์ม Word
- งานที่ต้องออกเอกสารหลายฉบับจากต้นทางชุดเดียว

---

## รันด้วย Docker

```bash
docker compose up --build
# เปิด http://127.0.0.1:3000
```

## เทสต์ผ่าน Docker

```bash
npm run test:docker
```

## พัฒนา local

```bash
npm i
cp .env.example .env.local   # ใส่ BETTER_AUTH_SECRET + Google OAuth
npm run dev
```

## ล็อกอิน (Better Auth)

- **ไม่มีรหัสผ่านในระบบ** — เข้าด้วย OAuth (Google เป็นหลัก) หรือพาสคีย์หลังล็อกอินสำเร็จแล้ว
- ผู้ให้บริการอื่นจะโผล่บนหน้า `/login` อัตโนมัติเมื่อใส่ `*_CLIENT_ID` + `*_CLIENT_SECRET` ใน env (ดู `.env.example`)
- พาสคีย์: เข้าสู่ระบบแล้วไปที่ `/account` → **เพิ่มพาสคีย์**
- เซสชันเก็บในคุกกี้ HttpOnly · PostgreSQL ผ่าน `DATABASE_URL` (ดู `docker compose` service `db`)
- Superadmin: อีเมลใน `SUPERADMIN_EMAILS` (ค่าเริ่มต้น `peerapat.srs@gmail.com`) ได้ role `superadmin` อัตโนมัติ
- Dev / SIT / UAT (`DEV_AUTH=1`): ระบบ seed ผู้ใช้จาก `DEV_AUTH_DEFAULT_EMAIL` (หรืออีเมลแรกใน `SUPERADMIN_EMAILS`) แบบ idempotent ตอน `auth:migrate` / บูตแอป เพื่อให้ `login-as` ใช้ได้โดยไม่ต้อง OAuth ก่อน — รันซ้ำด้วย `npm run auth:seed-qa`
- บังคับล็อกอินทั้งแอป: ตั้ง `AUTH_REQUIRED=1`

### Google OAuth (จำเป็นสำหรับเริ่มใช้)

1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. สร้าง **OAuth client ID** ชนิด Web application
3. Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - (โปรดักชัน) `https://your-domain/api/auth/callback/google`
4. ใส่ค่าใน `.env.local`:

```bash
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=   # openssl rand -base64 32
DATABASE_URL=postgres://docx:docx@127.0.0.1:5432/docx_form
SUPERADMIN_EMAILS=peerapat.srs@gmail.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

รัน Postgres โลคอล: `docker compose up -d db` แล้ว `npm run auth:migrate` (หรือแค่ `npm run dev` — migrate ตอนบูต)

### SEO / คำอธิบายผลิตภัณฑ์ (แหล่งเดียว)

ข้อความ title · description · Open Graph · JSON-LD อยู่ที่ `src/lib/site-meta.ts` — แก้ที่นั่นแล้ว README / meta HTML จะสอดคล้องกัน

ตั้ง `NEXT_PUBLIC_APP_URL` (หรือ `BETTER_AUTH_URL`) เป็น URL จริงของโปรดักชัน เพื่อให้ `metadataBase` และ canonical ถูกต้องสำหรับ Google

## License

[MIT](./LICENSE)
