const axios = require('axios');
const FormData = require('form-data');

async function readSlip(imageBuffer) {
  try {
    const form = new FormData();
    form.append('base64Image', 'data:image/jpeg;base64,' + imageBuffer.toString('base64'));
    form.append('language', 'tha');
    form.append('isOverlayRequired', 'false');
    form.append('detectOrientation', 'true');
    form.append('scale', 'true');
    form.append('OCREngine', '2');

    const response = await axios.post(
      'https://api.ocr.space/parse/image',
      form,
      {
        headers: { ...form.getHeaders(), 'apikey': process.env.OCR_API_KEY },
        timeout: 12000,
      }
    );

    const text = response.data?.ParsedResults?.[0]?.ParsedText || '';
    console.log('OCR Text:', text);

    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    console.log('OCR Lines:', lines);

    function isNameLine(str) {
      if (!str || str.length < 3) return false;
      if (/^\d{4,}/.test(str)) return false;
      if (/^[Xx]{2,}/i.test(str)) return false;
      if (/^\d{3}[-X\s]/i.test(str)) return false;
      if (/^x{1,3}-[\dxX]/i.test(str)) return false;
      if (/^(Bangkok Bank|Kasikorn|SCB|Krungthai|กรุงไทย|Krungsri|KKP|Siam Commercial Bank|UOB|UOB STASH|TMRW|ยูโอบี|TTB|GSB|ออมสิน|ธ\.กสิกรไทย|ธ\.ออมสิน|ธนาคาร|ธนาคารออมสิน|ธนาคารยูโอบี|กรุงเทพ|ไทยพาณิชย์|กสิกร|K\+)/i.test(str)) return false;
      if (/^(From|To|Fee|Amount|จาก|ไปยัง|ไปถึง|ถึง|จำนวนเงิน|จำนวน|ค่าธรรมเนียม|ฟรีค่าธรรมเนียม|วันที่|รหัสอ้างอิง|เลขที่รายการ|หมายเลขอ้างอิง|หมายเหตุ|โน้ตช่วยจำ|สแกน|สแกนตรวจสอบสลิป|Bank reference|Transaction|วันที่ทำรายการ|รหัสทำรายการ|ราคารอบอ|QR Code)(\s|:)?$/i.test(str)) return false;
      if (/^0\.00/.test(str)) return false;
      if (/^THB\s/i.test(str)) return false;
      if (/^\d{1,2}:\d{2}/.test(str)) return false;
      if (/^#/.test(str)) return false;
      if (/สแกน/.test(str)) return false;
      if (/ผู้รับเงินสามารถ/.test(str)) return false;
      if (/^\d{3}-\d{1,2}-[xX\d]{3,}/.test(str)) return false;
      if (/^[X\d]{6,}$/i.test(str)) return false;
      if (/^\d{4}[xX]{2,}\d+$/.test(str)) return false;
      return true;
    }

    function stripLabel(str) {
      return str.replace(/^(From|To|จาก|ไปยัง|ไปถึง|ถึง)\s+/i, '').trim();
    }

    function findNextName(startIndex) {
      for (let j = startIndex; j < Math.min(startIndex + 5, lines.length); j++) {
        const candidate = lines[j]?.trim();
        if (candidate && isNameLine(candidate)) return { name: candidate, index: j };
      }
      return null;
    }

    function findNamesByPrefix() {
      const thaiPrefixes = /^(นาย|นาง(?:สาว)?|น\.ส\.|นส\.|นส\b|บส\.|ด\.ช\.|ด\.ญ\.|บจก\.|หจก\.|บริษัท)/i;
      const engPrefixes  = /^(MR\.|MS\.|MRS\.|MISS\s)/i;
      return lines.filter(l => (thaiPrefixes.test(l) || engPrefixes.test(l)) && isNameLine(l));
    }

    let sender = null;
    let receiver = null;
    let mode = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const isFromLabel      = /^(From|จาก)(\s|$)/i.test(line);
      const isToLabel        = /^(To|ไปยัง|ไปถึง|ถึง)(\s|$)/i.test(line);
      const isMisreadToLabel = /^#[1Il]UOB$|^#IUOB$|^#IVOB$/i.test(line);
      const isArrow          = /^[↓→▼]$/.test(line);

      if (isFromLabel) {
        mode = 'from';
        const inline = stripLabel(line);
        if (inline && isNameLine(inline)) { sender = inline; continue; }
        const found = findNextName(i + 1);
        if (found && !sender) { sender = found.name; i = found.index; }
        continue;
      }
      if (isToLabel || isMisreadToLabel) {
        mode = 'to';
        const inline = stripLabel(line);
        if (inline && isNameLine(inline)) { receiver = inline; continue; }
        const found = findNextName(i + 1);
        if (found && !receiver) { receiver = found.name; i = found.index; }
        continue;
      }
      if (isArrow) { mode = 'to'; continue; }
      if (mode === 'from' && !sender && isNameLine(line)) { sender = line; continue; }
      if (mode === 'to' && !receiver && isNameLine(line)) { receiver = line; continue; }
      if (/^(Fee|Amount|จำนวนเงิน|จำนวน|Bank reference|Transaction|วันที่|ค่าธรรมเนียม|เลขที่รายการ|วันที่ทำรายการ)/i.test(line)) {
        mode = null;
      }
    }

    if (!sender || !receiver) {
      const unique = [...new Set(findNamesByPrefix())];
      if (unique.length >= 2) {
        if (!sender)   sender   = unique[0];
        if (!receiver) receiver = unique[1];
      } else if (unique.length === 1) {
        if (!sender) sender = unique[0];
      }
    }

    if (!sender && !receiver) {
      const arrowIdx = lines.findIndex(l => /^[↓→▼]$/.test(l));
      if (arrowIdx > 0) {
        for (let i = arrowIdx - 1; i >= 0; i--) {
          if (isNameLine(lines[i])) { sender = lines[i]; break; }
        }
        const found = findNextName(arrowIdx + 1);
        if (found) receiver = found.name;
      }
    }

    let amountMatch = null;
    amountMatch = text.match(/(?:จำนวน(?:เงิน)?)[:\s]*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)(?:\s*บาท)?/);
    if (!amountMatch) amountMatch = text.match(/(?:จำนวน(?:เงิน)?)[:\s]*(\d{1,6}(?:\.\d{2})?)/);
    if (!amountMatch) amountMatch = text.match(/Amount[^\d]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i);
    if (!amountMatch) amountMatch = text.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)\s*(?:บาท|THB|฿)/i);
    if (!amountMatch) amountMatch = text.match(/(\d{1,6}\.\d{2})\s*(?:บาท|THB|฿)/i);
    if (!amountMatch) amountMatch = text.match(/THB\s*(\d{1,3}(?:,\d{3})*\.\d{2})/);

    const rawAmount = amountMatch ? amountMatch[1] : null;
    const parsedAmount = rawAmount ? parseFloat(rawAmount.replace(/,/g, '')) : 0;
    const amount = parsedAmount >= 1 ? rawAmount : null;

    const dateMatch =
      text.match(/(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/) ||
      text.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/) ||
      text.match(/(\d{1,2}\s+(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{2,4})/) ||
      text.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{2,4})/i);
    const date = dateMatch ? dateMatch[1] : null;

    const timeMatch =
      text.match(/(\d{1,2}:\d{2}:\d{2})\s*(?:AM|PM|น\.)?/i) ||
      text.match(/(\d{1,2}:\d{2})\s*(?:AM|PM|น\.)?/i);
    const time = timeMatch ? timeMatch[1] : null;

    const slipKeywords = [
      'โอนเงินสำเร็จ','โอนเงิน','สำเร็จ','จำนวนเงิน','จำนวน',
      'รหัสอ้างอิง','เลขที่อ้างอิง','เลขที่รายการ','หมายเลขอ้างอิง',
      'พร้อมเพย์','ธนาคาร','ฟรีค่าธรรมเนียม',
      'กรุงไทย','กสิกร','ไทยพาณิชย์','กรุงเทพ',
      'ออมสิน','ทหารไทย','ธนชาต','กรุงศรี',
      'Transaction','Transfer','Success','successful',
      'Reference','PromptPay','Payment',
      'SCB','KBANK','KTB','BBL','BAY','TTB','UOB','TMRW',
      'Krungthai','Bangkok Bank','Kasikorn','Krungsri','KKP',
      'GSB','ไปยัง','ไปถึง','ถึง','รหัสทำรายการ',
      'รายการโอนเงินสำเร็จ','แกนกลางการเกษตร',
    ];

    const isSlip = slipKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));

    return { isSlip, amount, date, time, sender, receiver, text };
  } catch (err) {
    console.error('OCR error:', err.message);
    return { isSlip: false, amount: null, date: null, time: null, sender: null, receiver: null };
  }
}

module.exports = { readSlip };