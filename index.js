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

const client = new line.messagingApi.MessagingApiClient(config);
const blobClient = new line.messagingApi.MessagingApiBlobClient(config);

const GROUP_IDS = process.env.LINE_GROUP_IDS
  ? process.env.LINE_GROUP_IDS.split(',').map(id => id.trim())
  : [process.env.LINE_GROUP_ID];

async function pushToAllGroups(messages) {
  for (const groupId of GROUP_IDS) {
    try {
      await client.pushMessage({ 
        to: groupId, 
        pushMessageRequest: { messages } 
      });
    } catch (err) {
      console.error(`❌ Push Failed:`, err.message);
    }
  }
}

const app = express();
app.use('/webhook', line.middleware(config));

app.post('/webhook', (req, res) => {
  res.json({ status: 'ok' });
  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error('🔴 Webhook Error:', err));
});

async function handleEvent(event) {
  if (event.type === 'join') {
    const groupId = event.source.groupId;
    await client.replyMessage({
      replyToken: event.replyToken,
      replyMessageRequest: {
        messages: [{ type: 'text', text: `✅ บอทเข้ากลุ่มเรียบร้อยแล้ว!\nID: ${groupId}` }]
      }
    });
    return;
  }

  if (event.type !== 'message') return;

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'ยอดหนี้' || text === 'สรุปยอด') {
      const list = await getUnpaidList();
      await sendDebtSummary(list);
      return;
    }
    return;
  }

  if (event.message.type === 'image') {
    const messageId = event.message.id;
    const replyToken = event.replyToken;
    
    try {
      const responseStream = await blobClient.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of responseStream) { chunks.push(chunk); }
      const imageBuffer = Buffer.concat(chunks);
      
      const result = await readSlip(imageBuffer);
      
      // ป้องกันค่า null/undefined ที่ทำให้ LINE พ่น Error 400
      const safeStr = (v) => (v && String(v).trim().length > 0 ? String(v).trim() : 'ไม่ระบุ');

      const amount = safeStr(result.amount);
      const date = safeStr(result.date);
      const time = safeStr(result.time);
      const sender = safeStr(result.sender);
      const receiver = safeStr(result.receiver);

      let replyText = '';
      if (result.isSlip && amount !== 'ไม่ระบุ') {
        replyText = `✅ ตรวจสอบสลิปสำเร็จ\n💰 ยอดเงิน: ${amount} บาท\n📅 วันที่: ${date}\n⏰ เวลา: ${time}\n👤 ผู้โอน: ${sender}\n🏢 ผู้รับเงิน: ${receiver}`;
      } else {
        replyText = `❌ ไม่สามารถอ่านยอดเงินได้ชัดเจน กรุณาลองใหม่อีกครั้งนะคะ`;
      }

      // 🎯 ส่งกลับแบบ Reply (ฟรี) ด้วยโครงสร้างที่ LINE SDK v8 ยอมรับ 100%
      await client.replyMessage({
        replyToken: String(replyToken),
        replyMessageRequest: {
          messages: [{
            type: 'text',
            text: replyText
          }]
        }
      });
      console.log('✨ บอทตอบกลับสำเร็จ');
      
    } catch (err) {
      console.error('❌ Error:', err.message);
      try {
        await client.replyMessage({
          replyToken: String(replyToken),
          replyMessageRequest: {
            messages: [{ type: 'text', text: '⚠️ ระบบขัดข้องชั่วคราว กรุณาส่งใหม่อีกครั้งค่ะ' }]
          }
        });
      } catch (e) { console.error('Fallback Failed'); }
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 บอทพร้อมทำงานที่พอร์ต ${PORT}`));