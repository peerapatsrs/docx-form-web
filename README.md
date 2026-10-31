# docx-form-web

เวอร์ชัน **Next.js** ของ [docx-form](https://github.com/peerapatsrs/docx-form) — UI + API ชุดเดียวกับของเดิม (อัปโหลดเทมเพลต, กรอกฟอร์ม, แท็กเกอร์, Gemini แมป) รันใน Docker ได้

**Author:** Peerapat Surasing · peerapat.srs@gmail.com

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
- เซสชันเก็บในคุกกี้ HttpOnly · SQLite ที่ `data/auth.db` (หรือ `AUTH_DB_PATH`)
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
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## License

[MIT](./LICENSE)
