require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { getUnpaidList } = require('./sheets');
const { sendDebtSummary } = require('./notify');
const { readSlip } = require('./slip');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Client หลักสำหรับส่งข้อความ
const client = new line.messagingApi.MessagingApiClient(config);

// Client พิเศษสำหรับดึงไฟล์ภาพ (Blob)
const blobClient = new line.messagingApi.MessagingApiBlobClient(config);

const GROUP_IDS = process.env.LINE_GROUP_IDS
  ? process.env.LINE_GROUP_IDS.split(',').map(id => id.trim())
  : [process.env.LINE_GROUP_ID];

async function pushToAllGroups(messages) {
  for (const groupId of GROUP_IDS) {
    try {
      await client.pushMessage({ to: groupId, pushMessageRequest: { messages } });
    } catch (err) {
      console.error(`❌ ส่งไปกลุ่ม ${groupId} ไม่สำเร็จ:`, err.message);
    }
  }
}

const app = express();
app.use('/webhook', line.middleware(config));

app.post('/webhook', (req, res) => {
  res.json({ status: 'ok' });
  Promise.all(req.body.events.map(handleEvent)).catch(err => console.error(err));
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  // 1. จัดการข้อความตัวอักษร
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'ยอดหนี้' || text === 'สรุปยอด') {
      const list = await getUnpaidList();
      await sendDebtSummary(list);
    }
    return;
  }

  // 2. จัดการรูปภาพ (จุดที่แก้ไขล่าสุด)
  if (event.message.type === 'image') {
    const messageId = event.message.id;
    try {
      console.log(`📸 กำลังดึงไฟล์ภาพ Message ID: ${messageId}...`);

      // 🛠️ แก้ไข: ดึงข้อมูลเป็น Stream และแปลงเป็น Buffer (มาตรฐาน SDK v8)
      const stream = await blobClient.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);

      console.log('🔄 ดึงไฟล์สำเร็จ กำลังส่งให้ OCR...');

      const result = await readSlip(imageBuffer);
      
      let replyText = '';
      if (result.isSlip && result.amount) {
        replyText = `✅ ตรวจสอบสลิปสำเร็จ\n💰 จำนวนเงิน: ${result.amount} บาท\n📅 วันที่: ${result.date || '-'}\n⏰ เวลา: ${result.time || '-'}\n👤 ผู้โอน: ${result.sender || '-'}\n🏢 ผู้รับ: ${result.receiver || '-'}`;
      } else {
        replyText = `❌ ไม่พบข้อมูลสลิปที่ชัดเจน กรุณาส่งใหม่อีกครั้งค่ะ`;
      }

      await client.replyMessage({
        replyToken: event.replyToken,
        replyMessageRequest: { messages: [{ type: 'text', text: replyText }] }
      });
      console.log('✨ ตอบกลับสำเร็จ!');

    } catch (err) {
      console.error('❌ Slip Error:', err.message);
      await client.replyMessage({
        replyToken: event.replyToken,
        replyMessageRequest: { messages: [{ type: 'text', text: '⚠️ เกิดข้อผิดพลาดในการประมวลผลสลิปค่ะ' }] }
      }).catch(e => console.error('Fallback Error:', e.message));
    }
  }
}

// ระบบตั้งเวลา
cron.schedule('0 6 * * *', () => pushToAllGroups([{ type: 'text', text: '🌤️ สวัสดีตอนเช้าค่ะ!' }]), { timezone: 'Asia/Bangkok' });

app.listen(process.env.PORT || 3000, () => console.log('🚀 บอทพร้อมทำงานแล้ว!'));