// Гэр бүлийн цомог — Google Sheets ба Gmail холболт
// Энэ кодыг Google Sheets хүснэгтийнхээ Extensions → Apps Script хэсэгт хуулж тавина.
// TOKEN-ийг сайтын «Удирдлага» хуудсанд харагдах түлхүүрээр солино.

const TOKEN = 'ЭНД_ТҮЛХҮҮРЭЭ_ТАВЬ';

const SHEETS = {
  'Цомог': ['Огноо', 'Цомог', 'Хэн харах', 'Линк'],
  'Зураг': ['Нэмсэн', 'Цомог', 'Тайлбар', 'Зургийн огноо', 'Зураг', 'Цомгийн линк'],
  'Сэтгэгдэл': ['Огноо', 'Хэн', 'Сэтгэгдэл', 'Цомог', 'Линк'],
  'Илгээмж': ['Огноо', 'Хэн', 'Тэмдэглэл', 'Файлын тоо', 'Нийт МБ', 'Линк']
};

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_json' }); }
  if (!body || body.token !== TOKEN) return out({ ok: false, error: 'bad_token' });
  if (body.action === 'ping') return out({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getUrl(), mailLeft: MailApp.getRemainingDailyQuota() });
  if (body.action === 'mail') {
    MailApp.sendEmail({ to: String(body.to), subject: String(body.subject).slice(0, 200), htmlBody: String(body.html), name: 'Гэр бүлийн цомог' });
    return out({ ok: true });
  }
  if (body.action === 'log') {
    if (!SHEETS[body.sheet] || !Array.isArray(body.row)) return out({ ok: false, error: 'bad_sheet' });
    sheet(body.sheet).appendRow(body.row.slice(0, 10).map(v => typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v));
    return out({ ok: true });
  }
  return out({ ok: false, error: 'bad_action' });
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const head = SHEETS[name];
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#f3f3f3');
  }
  return sh;
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Эхний удаа зөвшөөрөл өгөхөд энийг сонгоод «Run» дарна.
function setup() {
  Object.keys(SHEETS).forEach(sheet);
  Logger.log('Бэлэн. Имэйл илгээх үлдэгдэл: ' + MailApp.getRemainingDailyQuota());
}
