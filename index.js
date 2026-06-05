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

// ── ประกาศ Client แยกตามเกณฑ์บังคับของ LINE SDK v8 ──
const client = new line.messagingApi.MessagingApiClient(config);
const blobClient = new line.messagingApi.MessagingApiBlobClient(config);

// รองรับทั้งแบบกลุ่มเดี่ยว และหลายกลุ่ม (คั่นด้วยเครื่องหมายจุลภาค , ใน Environment Variables)
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
      console.log(`✅ ส่งประกาศอัตโนมัติไปยังกลุ่ม ${groupId} สำเร็จ`);
    } catch (err) {
      console.error(`❌ ไม่สามารถส่งประกาศไปกลุ่ม ${groupId} ได้:`, err.message);
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
  // บอทส่ง Group ID คืนกลับมาเมื่อถูกเชิญเข้ากลุ่มไลน์ใหม่
  if (event.type === 'join') {
    const groupId = event.source.groupId;
    await client.replyMessage({
      replyToken: event.replyToken,
      replyMessageRequest: {
        messages: [{ type: 'text', text: `✅ บอทเข้ากลุ่มเรียบร้อยแล้วค่ะ!\nGroup ID ของกลุ่มนี้คือ:\n${groupId}` }]
      }
    });
    return;
  }

  if (event.type !== 'message') return;

  // ── 1. ส่วนจัดการข้อความตัวอักษร ──
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

  // ── 2. ส่วนจัดการรูปภาพสลิป (แก้ไขโครงสร้างเพื่อรองรับ SDK v8) ──
  if (event.message.type === 'image') {
    const messageId = event.message.id;
    const replyToken = event.replyToken;
    
    try {
      console.log(`📸 ได้รับรูปภาพ Message ID: ${messageId} กำลังดึง Stream ข้อมูล...`);
      
      // ✅ ดึงรูปภาพเป็นแบบ Readable Stream ผ่าน blobClient (แก้ปัญหาเรื่อง method เก่าไม่ทำงาน)
      const responseStream = await blobClient.getMessageContent(messageId);
      
      // ✅ รวบรวม Stream ข้อมูลทั้งหมดและประกอบร่างขึ้นมาเป็น Buffer
      const chunks = [];
      for await (const chunk of responseStream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);
      
      console.log('🔄 แปลงไฟล์รูปภาพเสร็จสิ้น กำลังส่งให้ระบบ OCR ประมวลผล...');
      
      // ส่ง Buffer ไปให้สแกนตัวอักษรใน slip.js (จำกัดเวลาทำงานไม่เกิน 20 วินาที)
      const result = await Promise.race([
        readSlip(imageBuffer),
        new Promise((_, rej) => setTimeout(() => rej(new Error('OCR Timeout')), 20000)),
      ]);
      
      // 🛡️ ป้องกัน Error 400: แปลงค่าที่เป็น null หรือ undefined ให้กลายเป็น Text เสมอ
      const amount = result.amount ? String(result.amount) : '';
      const date = result.date ? String(result.date) : 'ไม่ระบุ';
      const time = result.time ? String(result.time) : 'ไม่ระบุ';
      const sender = result.sender ? String(result.sender) : 'ไม่ระบุ';
      const receiver = result.receiver ? String(result.receiver) : 'ไม่ระบุ';

      let replyText = '';
      if (result.isSlip && amount) {
        replyText = `✅ ตรวจสอบสลิปสำเร็จ\n💰 ยอดเงิน: ${amount} บาท\n📅 วันที่โอน: ${date}\n⏰ เวลาโอน: ${time}\n👤 ผู้โอน: ${sender}\n🏢 ผู้รับเงิน: ${receiver}`;
      } else {
        replyText = `❌ บอทได้รับรูปภาพแล้ว แต่ไม่สามารถอ่านข้อมูลสลิปได้ชัดเจน หรือรูปภาพนี้ไม่ใช่สลิปโอนเงินที่ถูกต้อง กรุณาลองใหม่อีกครั้งนะคะ`;
      }

      console.log(`📤 กำลังตอบกลับข้อความไปยัง LINE...`);

      // ✅ ส่งผลลัพธ์หาผู้ใช้ด้วยโครงสร้าง replyMessageRequest
      await client.replyMessage({
        replyToken: replyToken,
        replyMessageRequest: {
          messages: [{
            type: 'text',
            text: String(replyText)
          }]
        }
      });
      console.log('✨ บอทตอบกลับข้อมูลสลิปเรียบร้อยแล้ว!');
      
    } catch (err) {
      console.error('❌ Slip check error:', err.message);
      
      // ดักจับกรณีระบบส่วนกลางขัดข้อง ให้บอทพิมพ์แจ้งเตือนแทนการนิ่งเงียบ
      try {
        await client.replyMessage({
          replyToken: replyToken,
          replyMessageRequest: {
            messages: [{ 
              type: 'text', 
              text: '⚠️ บอทได้รับภาพสลิปแล้ว แต่ระบบประมวลผลของสลิปเกิดข้อผิดพลาดชั่วคราว กรุณาส่งใหม่อีกครั้งนะคะ' 
            }]
          }
        });
      } catch (e) { 
        console.error('❌ Reply fallback error:', e.message); 
      }
    }
  }
}

// ── ข้อความประกาศประจำวัน ──
function morningMessage() {
  return { type: 'text', text: `🌤️ Good Morning ลูกค้าบ้านตระกูลจางทุกท่าน ☁️💛\nตื่นนอนแล้วอย่าลืมเข้าวงมาแจ้งเวลาส่งยอดกันน้า 🌷✨ วันนี้ขอให้เป็นวันที่ดี เงินเข้าเยอะ งานราบรื่น ค้าขายปังๆ เฮงๆ ตลอดวันเลยนะคะ 🫶🏻💸\n⏰ รบกวนเตรียมยอดชำระและแจ้งเวลาก่อน 12:00 น. เพื่อความสะดวกในการจัดคิวและดูแลยอดของทางบ้านนะคะ 🤍\nขอให้วันนี้มีแต่เรื่องน่ารักๆ สดใสทั้งวันเลยค่า 🌈💐` };
}

function nightMessage() {
  return { type: 'text', text: `📢 แจ้งลูกค้าบ้านตระกูลจางทุกท่าน\nพรุ่งนี้เป็นรอบส่งยอดประจำวัน กรุณาแจ้งเวลาส่งยอดก่อนเวลา 09:00 น.\n⏰ กำหนดชำระไม่เกิน 12:00 น. หากเกินเวลาที่กำหนด มีค่าปรับ 50 บาท / ชั่วโมง\n⚠️ หากไม่แจ้งก่อน 09:00 น. ทางบ้านขออนุญาตกดโกรธหน้าเฟส และไม่สามารถยกเลิกได้จนกว่าจะปิดยอดเรียบร้อย\n🙏 ขอความร่วมมือแจ้งเวลาและปิดยอดตรงเวลา เพื่อความสะดวกในการดูแลคิวและระบบของบ้านตระกูลจาง\nขอบคุณลูกค้าทุกท่านที่ให้ความร่วมมือเสมอ 🤍\n🌙 Good Night & Have a nice day na ka ✨💤 พักผ่อนเยอะๆ ดูแลตัวเองด้วยน้า 🫶🏻🤍` };
}

// ── ระบบตั้งเวลาทำงานอัตโนมัติ (Cron Job) ──
cron.schedule('0 6 * * *', async () => {
  console.log('⏰ ระบบอัตโนมัติส่งข้อความรอบเช้า (06:00 น.) เริ่มทำงาน');
  await pushToAllGroups([morningMessage()]);
}, { timezone: 'Asia/Bangkok' });

cron.schedule('0 21 * * *', async () => {
  console.log('⏰ ระบบอัตโนมัติส่งข้อความรอบดึก (21:00 น.) เริ่มทำงาน');
  await pushToAllGroups([nightMessage()]);
}, { timezone: 'Asia/Bangkok' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 บอทเวอร์ชันแก้บั๊กสลิปและข้อความแจ้งเตือน พร้อมใช้งานบนพอร์ต ${PORT}`));