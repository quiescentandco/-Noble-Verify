require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'service-account.json'),
  // เพิ่ม write scope เพื่อบันทึก ref สลิป
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ── Sheet1: ดึงรายการหนี้ ────────────────────────────────────────────────────
async function getUnpaidList() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Sheet1!A2:D',
  });
  const rows = res.data.values || [];
  return rows
    .filter(row => row[3] !== 'ชำระแล้ว' && row[1])
    .map(row => ({
      name: row[0] || '-',
      amount: row[1] || '0',
      dueDate: row[2] || '-',
      status: row[3] || 'ค้างชำระ',
    }));
}

// ── Sheet2: เช็คสลิปซ้ำ ──────────────────────────────────────────────────────
// โครงสร้าง Sheet2: | Ref No | จำนวน | ผู้โอน | ผู้รับ | วันที่ | เวลา | บันทึกเมื่อ |
async function isSlipDuplicate(refNo) {
  if (!refNo) return false;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet2!A2:A',
    });
    const rows = res.data.values || [];
    return rows.some(row => row[0] === refNo);
  } catch (err) {
    console.error('❌ isSlipDuplicate error:', err.message);
    return false;
  }
}

async function saveSlipRef({ refNo, amount, sender, receiver, date, time }) {
  if (!refNo) return;
  try {
    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet2!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[refNo, amount || '-', sender || '-', receiver || '-', date || '-', time || '-', now]],
      },
    });
    console.log('✅ บันทึก Ref สลิปแล้ว:', refNo);
  } catch (err) {
    console.error('❌ saveSlipRef error:', err.message);
  }
}

module.exports = { getUnpaidList, isSlipDuplicate, saveSlipRef };