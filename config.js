/**
 * Teams HRIS — Configuration
 *
 * แก้ไขไฟล์นี้เพื่อตั้งค่าระบบ แล้วกด Deploy ใหม่
 *
 * 1. API_BASE  → URL ของ backend server (ถ้ารันในเครื่องใช้ http://localhost:3001)
 *               ถ้า deploy backend ออนไลน์ให้ใส่ URL จริง เช่น https://myapp.up.railway.app
 *
 * 2. GOOGLE_CLIENT_ID → รับจาก Google Cloud Console
 *    ขั้นตอน: https://console.cloud.google.com
 *    → APIs & Services → Credentials → Create OAuth 2.0 Client ID
 *    → Application type: Web application
 *    → Authorized JavaScript origins: ใส่ URL ของเว็บ (เช่น https://padubgdech.github.io)
 *    → คัดลอก Client ID มาใส่ด้านล่าง
 */

window.HRIS_API_BASE         = 'https://teams-hris-production.up.railway.app';
window.HRIS_GOOGLE_CLIENT_ID = '261071644785-4a5jlonrubqang0ppn1bq05upc1g4tvt.apps.googleusercontent.com';
