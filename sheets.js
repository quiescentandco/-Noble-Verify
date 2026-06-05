require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'service-account.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

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

module.exports = { getUnpaidList };