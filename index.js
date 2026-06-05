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

// ประกาศ Client ตามมาตรฐาน LINE SDK v8
const client = new line.messagingApi.MessagingApiClient(config);
const blobClient = new line.messagingApi.MessagingApiBlobClient(config);

const GROUP_IDS = process.env.LINE_GROUP_IDS
  ? process.env.LINE_GROUP_IDS.split(',').map(id => id.trim())
  : [process.env.LINE_GROUP_ID];

// ฟังก์ชันประกาศอัตโนมัติ (จำเป็นต้องใช้ pushMessage เพราะรันตามเวลา ไม่มี replyToken จากแชท)
async function pushToAllGroups(messages) {
  for (const groupId of GROUP_IDS) {
    try {
      await client.pushMessage({ 
        to: groupId, 
        pushMessageRequest: { messages } 
      });
      console.log(`✅ ส่งประกาศอัตโนมัติไปกลุ่ม ${groupId} สำเร็จ`);
    } catch (err) {
      console.error(`❌ ส่งประกาศไปกลุ่ม ${groupId} ล้มเหลว:`, err.message);
    }
  }
}

const app = express();
app.use('/webhook', line.middleware(config));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
        messages: [{ type: 'text', text: `✅ บอทเข้ากลุ่มเรียบร้อยแล้วค่ะ!\nGroup ID:\n${groupId}` }]
      }
    });
    return;
  }

  if (event.type !== 'message') return;

  // ── 1. จัดการข้อความตัวอักษร (ใช้ replyMessage ฟรี 100%) ──
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'ยอดหนี้' || text === 'สรุปยอด') {
      const list = await getUnpaidList();
      await sendDebtSummary(list);
      return;
    }
    if (text === 'เช้า') {
      await client.replyMessage({ 
        replyToken: event.replyToken, 
        replyMessageRequest: { messages: [morningMessage()] } 
      });
      return;
    }
    if (text === 'คืน') {
      await client.replyMessage({ 
        replyToken: event.replyToken, 
        replyMessageRequest: { messages: [nightMessage()] } 
      });
      return;
    }
    return;
  }

  // ── 2. จัดการรูปภาพสลิป (ใช้ replyMessage โครงสร้าง v8 ป้องกัน Error 400 เพื่อใช้งานฟรี) ──
  if (event.message.type === 'image') {
    const messageId = event.message.id;
    const replyToken = event.replyToken; 
    
    try {
      console.log(`📸 ได้รับภาพสลิป Message ID: ${messageId} กำลังดึงไฟล์...`);
      const responseStream = await blobClient.getMessageContent(messageId);
      
      const chunks = [];
      for await (const chunk of responseStream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);
      
      console.log('🔄 ดึงไฟล์สำเร็จ ส่งให้ระบบ OCR ประมวลผล...');
      const result = await Promise.race([
        readSlip(imageBuffer),
        new Promise((_, rej) => setTimeout(() => rej(new Error('OCR Timeout')), 20000)),
      ]);
      
      // ป้องกันข้อความหลุดเป็นค่าว่างเพื่อไม่ให้ LINE ปฏิเสธ Request
      const cleanString = (val) => {
        if (!val) return 'ไม่ระบุ';
        let str = String(val).trim();
        return str.length > 0 ? str : 'ไม่ระบุ';
      };

      const amount = cleanString(result.amount);
      const date = cleanString(result.date);
      const time = cleanString(result.time);
      const sender = cleanString(result.sender);
      const receiver = cleanString(result.receiver);

      let replyText = '';
      if (result.isSlip && amount !== 'ไม่ระบุ') {
        replyText = `✅ ตรวจสอบสลิปสำเร็จ\n💰 ยอดเงิน: ${amount} บาท\n📅 วันที่: ${date}\n⏰ เวลา: ${time}\n👤 ผู้โอน: ${sender}\n🏢 ผู้รับเงิน: ${receiver}`;
      } else {
        replyText = `❌ ไม่สามารถอ่านยอดเงินบนสลิปได้ชัดเจน หรือรูปภาพนี้ไม่ใช่สลิปโอนเงินที่ถูกต้อง กรุณาลองใหม่อีกครั้งนะคะ`;
      }

      console.log(`📤 สั่งส่งข้อความตอบกลับฟรี (Reply): ${replyText.replace(/\n/g, ' ')}`);

      // 🎯 ส่งกลับด้วย replyMessage โครงสร้างตรงตามเกณฑ์ SDK v8 เป๊ะ 100%
      await client.replyMessage({
        replyToken: String(replyToken),
        replyMessageRequest: {
          messages: [{
            type: 'text',
            text: String(replyText)
          }]
        }
      });
      console.log('✨ บอทตอบกลับแบบไม่เสียโควตาข้อความเรียบร้อยแล้ว');
      
    } catch (err) {
      console.error('❌ Slip Error:', err.message);
      
      // ตัวสำรองกรณีเกิด Error ก็ใช้โครงสร้าง replyMessage ของ SDK v8 เพื่อความปลอดภัย
      try {
        await client.replyMessage({
          replyToken: String(replyToken),
          replyMessageRequest: {
            messages: [{ 
              type: 'text', 
              text: '⚠️ บอทได้รับภาพสลิปแล้ว แต่ระบบอ่านข้อมูลขัดข้องชั่วคราว กรุณาส่งใหม่อีกครั้งนะคะ' 
            }]
          }
        });
      } catch (fallbackErr) { 
        console.error('❌ Fallback Reply Failed:', fallbackErr.message); 
      }
    }
  }
}

function morningMessage() {
  return { type: 'text', text: `🌤️ Good Morning ลูกค้าบ้านตระกูลจางทุกท่าน ☁️💛\nตื่นนอนแล้วอย่าลืมเข้าวงมาแจ้งเวลาส่งยอดกันน้า 🌷✨ วันนี้ขอให้เป็นวันที่ดี เงินเข้าเยอะ งานราบรื่น ค้าขายปังๆ เฮงๆ ตลอดวันเลยนะคะ 🫶🏻💸\n⏰ รบกวนเตรียมยอดชำระและแจ้งเวลาก่อน 12:00 น. เพื่อความสะดวกในการจัดคิวและดูแลยอดของทางบ้านนะคะ 🤍\nขอให้วันนี้มีแต่เรื่องน่ารักๆ สดใสทั้งวันเลยค่า 🌈💐` };
}

function nightMessage() {
  return { type: 'text', text: `📢 แจ้งลูกค้าบ้านตระกูลจางทุกท่าน\nพรุ่งนี้เป็นรอบส่งยอดประจำวัน กรุณาแจ้งเวลาส่งยอดก่อนเวลา 09:00 น.\n⏰ 定หนดชำระไม่เกิน 12:00 น. หากเกินเวลาที่กำหนด มีค่าปรับ 50 บาท / ชั่วโมง\n⚠️ หากไม่แจ้งก่อน 09:00 น. ทางบ้านขออนุญาตกดโกรธหน้าเฟส และไม่สามารถยกเลิกได้จนกว่าจะปิดยอดเรียบร้อย\n🙏 ขอความร่วมมือแจ้งเวลาและปิดยอดตรงเวลา เพื่อความสะดวกในการดูแลคิวและระบบของบ้านตระกูลจาง\nขอบคุณลูกค้าทุกท่านที่ให้ความร่วมมือเสมอ 🤍\n🌙 Good Night & Have a nice day na ka ✨💤 พักผ่อนเยอะๆ ดูแลตัวเองด้วยน้า 🫶🏻🤍` };
}

cron.schedule('0 6 * * *', async () => {
  await pushToAllGroups([morningMessage()]);
}, { timezone: 'Asia/Bangkok' });

cron.schedule('0 21 * * *', async () => {
  await pushToAllGroups([nightMessage()]);
}, { timezone: 'Asia/Bangkok' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 บอทเวอร์ชันใช้ Reply ฟรี ไม่จำกัดข้อความ พร้อมรันพอร์ต ${PORT}`));