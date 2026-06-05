require('dotenv').config();
const line = require('@line/bot-sdk');

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

async function sendDebtSummary(debtList) {
  if (debtList.length === 0) {
    return client.pushMessage({
      to: process.env.LINE_GROUP_ID,
      messages: [{ type: 'text', text: '✅ ไม่มียอดค้างชำระในวันนี้' }],
    });
  }
  const lines = debtList.map((d, i) =>
    `${i + 1}. ${d.name}\n   💰 ยอด: ${Number(d.amount).toLocaleString()} บาท\n   📅 ครบกำหนด: ${d.dueDate}`
  );
  const message = [
    '🔔 สรุปยอดค้างชำระประจำวัน',
    `📋 พบ ${debtList.length} รายการ`,
    '─────────────────',
    ...lines,
    '─────────────────',
    `💵 รวมทั้งหมด: ${debtList.reduce((sum, d) => sum + Number(d.amount), 0).toLocaleString()} บาท`,
  ].join('\n');
  return client.pushMessage({
    to: process.env.LINE_GROUP_ID,
    messages: [{ type: 'text', text: message }],
  });
}

module.exports = { sendDebtSummary };