require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
const { getUnpaidList } = require('./sheets');
const { sendDebtSummary } = require('./notify');
const { readSlip } = require('./slip');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const GROUP_IDS = process.env.LINE_GROUP_IDS
  ? process.env.LINE_GROUP_IDS.split(',').map(id => id.trim())
  : [process.env.LINE_GROUP_ID];

async function pushToAllGroups(messages) {
  for (const groupId of GROUP_IDS) {
    try {
      await client.pushMessage({ to: groupId, messages });
      console.log(`✅ ส่งไปกลุ่ม ${groupId} สำเร็จ`);
    } catch (err) {
      console.error(`❌ Push Failed [${groupId}]:`, err.message);
    }
  }
}

// ── Helper: safe reply ─────────────────────────────────────────────────────
async function safeReply(replyToken, messages) {
  try {
    await client.replyMessage({ replyToken, messages });
    console.log('✅ Reply OK');
  } catch (err) {
    const body = err.response?.data ?? err.originalError?.response?.data ?? null;
    console.error('❌ replyMessage failed:', err.message);
    console.error('❌ replyMessage body:', JSON.stringify(body));
    throw err;
  }
}

const app = express();
app.use('/webhook', line.middleware(config));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/webhook', (req, res) => {
  res.json({ status: 'ok' });
  Promise.all(req.body.events.map(handleEvent))
    .catch(err => console.error('🔴 Webhook Error:', err.message));
});

async function handleEvent(event) {
  console.log('📩 Event:', event.type, '| Source:', JSON.stringify(event.source));

  if (event.type === 'join') {
    const groupId = event.source.groupId;
    await safeReply(event.replyToken, [
      { type: 'text', text: `✅ Bot เข้ากลุ่มแล้ว!\nGroup ID:\n${groupId}` }
    ]);
    return;
  }

  if (event.type !== 'message') return;

  // ── Text ────────────────────────────────────────────────
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'ยอดหนี้' || text === 'สรุปยอด') {
      const list = await getUnpaidList();
      await sendDebtSummary(list);
      return;
    }
    if (text === 'เช้า') {
      await safeReply(event.replyToken, [morningMessage()]);
      return;
    }
    if (text === 'คืน') {
      await safeReply(event.replyToken, [nightMessage()]);
      return;
    }
    return;
  }

  // ── Image (สลิป) ─────────────────────────────────────────
  if (event.message.type === 'image') {
    const messageId = event.message.id;
    const replyToken = event.replyToken;

    try {
      const stream = await blobClient.getMessageContent(messageId);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const imageBuffer = Buffer.concat(chunks);
      console.log('🖼️ Image size:', imageBuffer.length, 'bytes');

      const { isSlip, amount, date, time, sender, receiver } = await Promise.race([
        readSlip(imageBuffer),
        new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout after 15s')), 15000)),
      ]);

      console.log('📋 OCR result:', { isSlip, amount, date, time, sender, receiver });

      await safeReply(replyToken, [
        (isSlip && amount)
          ? buildSlipSuccessCard({ amount, date, time, sender, receiver })
          : buildSlipFailCard()
      ]);

    } catch (err) {
      console.error('❌ Slip error:', err.message);
      try {
        await safeReply(replyToken, [
          { type: 'text', text: '⚠️ ตรวจสอบไม่สำเร็จ กรุณาส่งสลิปใหม่อีกครั้งนะคะ' }
        ]);
      } catch (_) { /* safeReply log แล้ว */ }
    }
  }
}

// ── Flex Cards ──────────────────────────────────────────────────────────────
function buildSlipSuccessCard({ amount, date, time, sender, receiver }) {
  const safe = v => (v && String(v).trim()) || 'ไม่พบข้อมูล';
  return {
    type: 'flex',
    altText: `✅ สลิปถูกต้อง | ${safe(amount)} บาท`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '0px',
        contents: [
          {
            type: 'box', layout: 'horizontal', paddingAll: '0px', height: '6px',
            contents: [
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FF0018', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FF7A00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FFFF00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#00C800', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#0000FF', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#8B00FF', contents: [] },
            ],
          },
          {
            type: 'box', layout: 'vertical', paddingAll: '10px', paddingBottom: '13px', backgroundColor: '#3A241B',
            contents: [
              { type: 'text', text: 'สลิปถูกต้อง', color: '#C8A46B', size: 'xl', weight: 'bold' },
              { type: 'text', text: 'Noble Verify · Pride Month 2026', color: '#C8A46B', size: 'xs', margin: 'sm' },
            ],
          },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: '#F8F5F0', paddingAll: '10px',
        contents: [
          {
            type: 'box', layout: 'horizontal', alignItems: 'center',
            contents: [
              { type: 'box', layout: 'vertical', width: '9px', height: '9px', cornerRadius: '5px', backgroundColor: '#00C851', contents: [] },
              { type: 'text', text: ' โอนเงินสำเร็จ', size: 'sm', color: '#C8A46B', weight: 'bold' },
            ],
          },
          { type: 'separator', color: '#eeeeee' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ผู้โอนเงิน', size: 'sm', color: '#888888', flex: 4 },
            { type: 'text', text: safe(sender), size: 'sm', color: '#333333', weight: 'bold', flex: 6, wrap: true, align: 'end' },
          ]},
          { type: 'separator', color: '#eeeeee' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'ผู้รับโอน', size: 'sm', color: '#888888', flex: 4 },
            { type: 'text', text: safe(receiver), size: 'sm', color: '#333333', weight: 'bold', flex: 6, wrap: true, align: 'end' },
          ]},
          { type: 'separator', color: '#eeeeee' },
          { type: 'box', layout: 'horizontal', alignItems: 'center', backgroundColor: '#f8f8f8', cornerRadius: '5px', paddingAll: '7px', contents: [
            { type: 'text', text: 'จำนวนเงิน', size: 'sm', color: '#888888', flex: 4 },
            { type: 'text', text: `${safe(amount)} บาท`, size: 'sm', weight: 'bold', color: '#C8A46B', flex: 6, align: 'end' },
          ]},
          { type: 'separator', color: '#eeeeee' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'วันที่', size: 'sm', color: '#888888', flex: 4 },
            { type: 'text', text: safe(date), size: 'sm', color: '#333333', flex: 6, align: 'end' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'เวลา', size: 'sm', color: '#888888', flex: 4 },
            { type: 'text', text: safe(time), size: 'sm', color: '#333333', flex: 6, align: 'end' },
          ]},
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '0px',
        contents: [
          {
            type: 'box', layout: 'horizontal', paddingAll: '0px', height: '4px',
            contents: [
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#FF0018', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#FF7A00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#FFFF00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#00C800', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#0000FF', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '4px', backgroundColor: '#8B00FF', contents: [] },
            ],
          },
          { type: 'box', layout: 'horizontal', paddingAll: '5px', backgroundColor: '#F8F5F0', alignItems: 'center', contents: [
            
            { type: 'text', text: ' 🌈 Love is Love ', size: 'xxs', color: '#C8A46B', flex: 1 },
          ]},
        ],
      },
    },
  };
}

function buildSlipFailCard() {
  return {
    type: 'flex',
    altText: '❌ สลิปไม่ถูกต้อง',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '0px',
        contents: [
          {
            type: 'box', layout: 'horizontal', paddingAll: '0px', height: '6px',
            contents: [
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FF0018', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FF7A00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#FFFF00', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#00C800', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#0000FF', contents: [] },
              { type: 'box', layout: 'vertical', flex: 1, height: '6px', backgroundColor: '#8B00FF', contents: [] },
            ],
          },
          { type: 'box', layout: 'vertical', backgroundColor: '#E74C3C', paddingAll: '10px', paddingBottom: '13px', contents: [
            { type: 'text', text: 'สลิปไม่ถูกต้อง', color: '#C8A46B', size: 'xl', weight: 'bold' },
            { type: 'text', text: 'Noble Verify · Pride Month 2026', color: '#C8A46B', size: 'xs', margin: 'sm' },
          ]},
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'ไม่พบข้อมูลการโอนเงิน', size: 'md', weight: 'bold', align: 'center', color: '#333333' },
          { type: 'text', text: 'กรุณาส่งสลิปจริงจากแอปธนาคารนะคะ', size: 'sm', wrap: true, align: 'center', color: '#666666', margin: 'sm' },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', paddingAll: '5px', backgroundColor: '#F8F5F0', alignItems: 'center',
        contents: [
          { type: 'text', text: ' 🌈 Love is Love ', size: 'xxs', color: '#C8A46B', flex: 1 },
        ],
      },
    },
  };
}

function morningMessage() {
  return { type: 'text', text: `🌤️ Good Morning ลูกค้าบ้านตระกูลจางทุกท่าน ☁️💛\nตื่นนอนแล้วอย่าลืมเข้าวงมาแจ้งเวลาส่งยอดกันน้า 🌷✨ วันนี้ขอให้เป็นวันที่ดี เงินเข้าเยอะ งานราบรื่น ค้าขายปังๆ เฮงๆ ตลอดวันเลยนะคะ 🫶🏻💸\n⏰ รบกวนเตรียมยอดชำระและแจ้งเวลาก่อน 12:00 น. เพื่อความสะดวกในการจัดคิวและดูแลยอดของทางบ้านนะคะ 🤍\nขอให้วันนี้มีแต่เรื่องน่ารักๆ สดใสทั้งวันเลยค่า 🌈💐` };
}

function nightMessage() {
  return { type: 'text', text: `📢 แจ้งลูกค้าบ้านตระกูลจางทุกท่าน\nพรุ่งนี้เป็นรอบส่งยอดประจำวัน กรุณาแจ้งเวลาส่งยอดก่อนเวลา 09:00 น.\n⏰ กำหนดชำระไม่เกิน 12:00 น. หากเกินเวลาที่กำหนด มีค่าปรับ 50 บาท / ชั่วโมง\n⚠️ หากไม่แจ้งก่อน 09:00 น. ทางบ้านขออนุญาตกดโกรธหน้าเฟส และไม่สามารถยกเลิกได้จนกว่าจะปิดยอดเรียบร้อย\n🙏 ขอความร่วมมือแจ้งเวลาและปิดยอดตรงเวลา เพื่อความสะดวกในการดูแลคิวและระบบของบ้านตระกูลจาง\nขอบคุณลูกค้าทุกท่านที่ให้ความร่วมมือเสมอ 🤍\n🌙 Good Night & Have a nice day na ka ✨💤 พักผ่อนเยอะๆ ดูแลตัวเองด้วยน้า 🫶🏻🤍` };
}

// ── Cron ────────────────────────────────────────────────────────────────────
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ Cron 06:00 เช้า');
  await pushToAllGroups([morningMessage()]);
}, { timezone: 'Asia/Bangkok' });

cron.schedule('0 21 * * *', async () => {
  console.log('⏰ Cron 21:00 คืน');
  await pushToAllGroups([nightMessage()]);
}, { timezone: 'Asia/Bangkok' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));