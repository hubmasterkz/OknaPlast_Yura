/**
 * OKNA PLAST — Юрий (окна, сетки, решётки, ремонт окон, изготовление окон)
 * WhatsApp бот на базе Claude + Wazzup24 (ещё один OLX-номер на общем аккаунте)
 * База знаний — общая (таблица knowledge). Хранилище: PostgreSQL (общая база)
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WAZZUP_API_KEY    = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL_ID = process.env.WAZZUP_CHANNEL_ID;
const PORT              = process.env.PORT || 3000;
const MODEL             = "claude-sonnet-4-5-20250929";
const WAZZUP_API_URL    = "https://api.wazzup24.com/v3";
const BOT_NAME          = "yuriy"; // отдельные данные/нумерация в общей БД

// Источник заявки и брендинг для Telegram
const SOURCE_NUMBER = "OKNA PLAST";
const SHOP_NAME     = "OKNA PLAST";

// CRM webhook (отправка заявок в Google Apps Script CRM)
const CRM_WEBHOOK_URL    = process.env.CRM_WEBHOOK_URL || "https://script.google.com/macros/s/AKfycbwojTX7O0UaOmE4K4EqDmEsrCXxyJTj6MYHmzv1eDalDGeJOr8s034sp4UGmer6BFkG/exec";
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || "hubmaster_crm_2026";
const CRM_SEND_UPDATES   = String(process.env.CRM_SEND_UPDATES || "false").toLowerCase() === "true";

// ── PostgreSQL ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      messages JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      raw TEXT,
      type TEXT DEFAULT 'lead',
      bot TEXT DEFAULT 'ablaikhan',
      daily_number INT,
      date TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      raw TEXT,
      bot TEXT DEFAULT 'ablaikhan',
      date TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS paused_chats (
      phone TEXT NOT NULL,
      bot TEXT NOT NULL DEFAULT 'ablaikhan',
      PRIMARY KEY (phone, bot)
    );
    CREATE TABLE IF NOT EXISTS daily_activity (
      almaty_date TEXT NOT NULL,
      phone TEXT NOT NULL,
      bot TEXT NOT NULL DEFAULT 'ablaikhan',
      PRIMARY KEY (almaty_date, phone, bot)
    );
    CREATE TABLE IF NOT EXISTS knowledge (
      id INT PRIMARY KEY DEFAULT 1,
      content TEXT DEFAULT ''
    );
    INSERT INTO knowledge (id, content) VALUES (1, '') ON CONFLICT DO NOTHING;
  `);

  // Совместимость со старой схемой: добавляем колонку bot и ключи если их нет
  await pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS bot TEXT DEFAULT 'ablaikhan';
    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS bot TEXT DEFAULT 'ablaikhan';
  `).catch(() => {});

  // paused_chats и daily_activity в старой схеме Абылайхана были без bot и с другим PK.
  // Безопасно добавляем колонку bot (если таблицы старые — миграцию PK не трогаем, фильтр по bot всё равно сработает).
  await pool.query(`ALTER TABLE paused_chats ADD COLUMN IF NOT EXISTS bot TEXT DEFAULT 'ablaikhan';`).catch(() => {});
  await pool.query(`ALTER TABLE daily_activity ADD COLUMN IF NOT EXISTS bot TEXT DEFAULT 'ablaikhan';`).catch(() => {});

  console.log("✅ БД инициализирована (OKNA PLAST / Юрий)");
}

// ── Knowledge ───────────────────────────────────────────────
async function loadKnowledge() {
  try {
    const r = await pool.query("SELECT content FROM knowledge WHERE id=1");
    return r.rows[0]?.content || "";
  } catch { return ""; }
}

async function saveKnowledge(content) {
  await pool.query("UPDATE knowledge SET content=$1 WHERE id=1", [content]);
}

// ── Conversations ────────────────────────────────────────────
// Ключ ablaikhan_{phone} чтобы не пересекаться с Нурсултаном в общей таблице
async function loadHistory(phone) {
  const key = `${BOT_NAME}_${phone}`;
  try {
    const r = await pool.query("SELECT messages FROM conversations WHERE phone=$1", [key]);
    return r.rows[0]?.messages || [];
  } catch { return []; }
}

async function saveHistory(phone, messages) {
  const key = `${BOT_NAME}_${phone}`;
  await pool.query(`
    INSERT INTO conversations (phone, messages, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (phone) DO UPDATE SET messages=$2, updated_at=NOW()
  `, [key, JSON.stringify(messages)]);
}

// ── Paused chats ─────────────────────────────────────────────
async function isPaused(phone) {
  const r = await pool.query("SELECT 1 FROM paused_chats WHERE phone=$1 AND bot=$2", [phone, BOT_NAME]);
  return r.rowCount > 0;
}
async function setPaused(phone) {
  await pool.query("INSERT INTO paused_chats (phone, bot) VALUES ($1, $2) ON CONFLICT DO NOTHING", [phone, BOT_NAME]);
}
async function setUnpaused(phone) {
  await pool.query("DELETE FROM paused_chats WHERE phone=$1 AND bot=$2", [phone, BOT_NAME]);
}
async function getPausedList() {
  const r = await pool.query("SELECT phone FROM paused_chats WHERE bot=$1", [BOT_NAME]);
  return r.rows.map(x => x.phone);
}

// ── Daily activity ───────────────────────────────────────────
async function trackDialog(phone) {
  const today = getAlmatyDate();
  await pool.query(`
    INSERT INTO daily_activity (almaty_date, phone, bot) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
  `, [today, phone, BOT_NAME]);
}

async function getDayDialogCount(almatyDate) {
  const r = await pool.query("SELECT COUNT(*) FROM daily_activity WHERE almaty_date=$1 AND bot=$2", [almatyDate, BOT_NAME]);
  return parseInt(r.rows[0].count);
}

// ── Парсинг полей и форматирование Telegram-карточки ──────────
function fieldFrom(raw, name) {
  const m = (raw || "").match(new RegExp(`${name}\\s*:\\s*([^\\n]*)`, "i"));
  if (!m) return "";
  return m[1].trim()
    .replace(/\s*(Имя|Телефон|Город|Адрес|Направление|Услуга|Время|Комментарий)\s*:.*$/i, "")
    .trim();
}

// Страховка: если бот не проставил Направление — вычисляем из услуги
function detectDirection(service) {
  const s = (service || "").toLowerCase();
  if (/антивор/.test(s) || (/кован/.test(s) && /решёт|решет/.test(s))) return "Окна"; // кованые решётки (антивор) — это окна, НЕ металлоконструкции
  if (/выпадени|защита детей|защита от выпадения|детск.*решёт|детск.*решет/.test(s)) return "Окна";
  if (/металлоконструкц|свар|ворот|калитк|забор|навес|козыр|перил|лестниц|ограждени/.test(s)) return "Сервис";
  if (/мебел|шкаф|кухн|гардероб|кроват|комод|тумб|стеллаж|витрин|стол|стул|диван|кресл|полк|ресепшн/.test(s)) return "Мебель";
  if (/стирал|холодил|посудомо|вытяжк|кондицион|электроплит|плит|техник|электр|розетк|выключател|люстр|провод|электрощит|щиток|тёплый пол|теплый пол|клининг|уборк/.test(s)) return "Сервис";
  if (/сетк|москит|плисс|антикошк|антимошк|антипыл|ультравью|решёт|решет|окно|окон|окна|пластиков|алюмин|ролл|жалюз|кован|раздвиж|уплотнит|фурнитур|стеклопакет/.test(s)) return "Окна";
  return "Без кв.";
}


// Выбор телефона: если клиент назвал казахстанский номер в тексте заявки — берём его, иначе номер WhatsApp
function pickPhone(raw, waPhone) {
  const field = fieldFrom(raw, "Телефон");
  if (field) {
    const digits = field.replace(/[^\d]/g, "");
    // казахстанский мобильный: 11 цифр на 7/8, или 10 цифр на 7
    if (/^(7|8)\d{10}$/.test(digits)) return digits.replace(/^8/, "7");
    if (/^7\d{9}$/.test(digits)) return "7" + digits.slice(1);
    if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return digits.replace(/^8/, "7");
  }
  return (waPhone || "").replace(/[^\d]/g, "");
}

function formatCard(header, phone, raw, dailyNumber, globalId) {
  const name = fieldFrom(raw, "Имя") || "—";
  const city = fieldFrom(raw, "Город") || "—";
  const addr = fieldFrom(raw, "Адрес");
  const service = fieldFrom(raw, "Услуга") || "—";
  const time = fieldFrom(raw, "Время");
  const comment = fieldFrom(raw, "Комментарий");
  let direction = fieldFrom(raw, "Направление");
  if (!direction) direction = detectDirection(service); // страховка
  const phoneClean = pickPhone(raw, phone);

  let t = `🔔 ${header}${globalId ? ' #' + globalId : ''}\n\n`;
  t += `📋 Заявка №${dailyNumber} за сегодня\n`;
  t += `📞 Источник: ${SOURCE_NUMBER}\n\n`;
  t += `👤 Имя: ${name}\n`;
  t += `📱 Телефон: +${phoneClean}\n`;
  t += `🏙 Город: ${city}\n`;
  if (addr) t += `📍 Адрес: ${addr}\n`;
  t += `🔧 Направление: ${direction}\n`;
  t += `🛠 Услуга: ${service}\n`;
  if (comment && comment !== "—") t += `💬 Комментарий: ${comment}\n`;
  if (time) t += `⏰ Время: ${time}\n`;
  return t;
}

// ── CRM webhook ──────────────────────────────────────────────
function buildCrmLeadPayload(phone, raw, dailyNumber, globalId, eventType) {
  const name = fieldFrom(raw, "Имя") || "";
  const city = fieldFrom(raw, "Город") || "";
  const address = fieldFrom(raw, "Адрес") || "";
  const service = fieldFrom(raw, "Услуга") || "Без кв.";
  const time = fieldFrom(raw, "Время") || "";
  const comment = fieldFrom(raw, "Комментарий") || "";
  let direction = fieldFrom(raw, "Направление");
  if (!direction) direction = detectDirection(service);
  const phoneClean = pickPhone(raw, phone);
  const waPhoneClean = String(phone || "").replace(/[^\d]/g, "");

  return {
    secret: CRM_WEBHOOK_SECRET,
    source: SOURCE_NUMBER,
    leadSource: SOURCE_NUMBER,
    sourceBot: BOT_NAME,
    bot: BOT_NAME,
    shopName: SHOP_NAME,
    sourceNumber: SOURCE_NUMBER,
    eventType: eventType || "new_lead",
    globalId: globalId || null,
    externalId: globalId ? String(globalId) : (BOT_NAME + "_lead_" + phoneClean + "_" + dailyNumber),
    dailyNumber,
    clientName: name,
    name,
    phone: phoneClean ? "+" + phoneClean : "",
    waPhone: waPhoneClean ? "+" + waPhoneClean : "",
    city,
    address,
    direction: direction || "Без кв.",
    niche: direction || "Без кв.",
    service: service || "Без кв.",
    preferredTime: time,
    comment,
    rawText: raw,
    createdAt: new Date().toISOString()
  };
}

async function sendLeadToCrm(phone, raw, dailyNumber, globalId, eventType = "new_lead") {
  if (!CRM_WEBHOOK_URL) {
    console.log("⚠️ CRM_WEBHOOK_URL не задан — в CRM не отправляем");
    return { ok: false, skipped: true };
  }
  const payload = buildCrmLeadPayload(phone, raw, dailyNumber, globalId, eventType);
  try {
    const resp = await axios.post(CRM_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json", "X-CRM-SECRET": CRM_WEBHOOK_SECRET },
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024
    });
    console.log("✅ CRM: " + payload.externalId + " отправлено, статус " + resp.status);
    return { ok: true };
  } catch (e) {
    console.error("❌ CRM send error:", e.response?.data || e.message);
    return { ok: false, error: e.response?.data || e.message };
  }
}


async function sendRefusalToCrm(phone, analysis, waited, refusalGlobalId) {
  if (!CRM_WEBHOOK_URL) {
    console.log("⚠️ CRM_WEBHOOK_URL не задан — отказ в CRM не отправляем");
    return { ok: false, skipped: true };
  }

  // Ищем последнюю обычную заявку клиента, чтобы подтянуть имя/адрес/город.
  // Если заявки не было — всё равно отправляем отказ в CRM, а CRM создаст карточку сразу в "Отказ/Завершено".
  let latestLead = null;
  try {
    const r = await pool.query(`
      SELECT id, daily_number, raw FROM leads
      WHERE phone=$1 AND bot=$2 AND type='lead'
      ORDER BY date DESC LIMIT 1
    `, [phone, BOT_NAME]);
    latestLead = r.rows[0] || null;
  } catch (e) {
    console.error("❌ CRM refusal: не удалось найти последнюю заявку:", e.message);
  }

  const latestRaw = latestLead && latestLead.raw ? latestLead.raw : "";
  const phoneClean = latestRaw ? pickPhone(latestRaw, phone) : String(phone || "").replace(/[^\d]/g, "");
  const waPhoneClean = String(phone || "").replace(/[^\d]/g, "");

  const clientName = latestRaw ? (fieldFrom(latestRaw, "Имя") || "") : "";
  const clientCity = latestRaw ? (fieldFrom(latestRaw, "Город") || "") : "";
  const clientAddr = latestRaw ? (fieldFrom(latestRaw, "Адрес") || "") : "";
  const latestComment = latestRaw ? (fieldFrom(latestRaw, "Комментарий") || "") : "";
  const latestTime = latestRaw ? (fieldFrom(latestRaw, "Время") || "") : "";

  const refusalDirection = (analysis && analysis.direction) || (latestRaw ? detectDirection(fieldFrom(latestRaw, "Услуга")) : "Без кв.");
  const refusalService = (analysis && analysis.service) || (latestRaw ? (fieldFrom(latestRaw, "Услуга") || "Без кв.") : "Без кв.");
  const refusalReason = (analysis && analysis.reason) || "";
  const refusalLast = (analysis && analysis.last) || "";

  const rawText =
    (latestRaw ? "Данные последней заявки:\n" + latestRaw + "\n\n" : "") +
    "Данные отказа:\n" +
    "Направление: " + refusalDirection + "\n" +
    "Услуга: " + refusalService + "\n" +
    "Причина: " + refusalReason + "\n" +
    "Последнее: " + (refusalLast || "—");

  const payload = {
    secret: CRM_WEBHOOK_SECRET,
    source: SOURCE_NUMBER,
    leadSource: SOURCE_NUMBER,
    sourceNumber: SOURCE_NUMBER,
    sourceBot: BOT_NAME,
    bot: BOT_NAME,
    shopName: SHOP_NAME,

    eventType: "refusal",
    status: "Отказ/Завершено",

    // ID оставляем как справочную информацию. CRM не обязана искать карточку по нему.
    botLeadId: latestLead && latestLead.id ? String(latestLead.id) : "",
    refusalGlobalId: refusalGlobalId ? String(refusalGlobalId) : "",
    dailyNumber: latestLead && latestLead.daily_number ? latestLead.daily_number : "",

    clientName,
    name: clientName,
    phone: phoneClean ? "+" + phoneClean : "",
    waPhone: waPhoneClean ? "+" + waPhoneClean : "",
    city: clientCity,
    address: clientAddr,

    direction: refusalDirection || "Без кв.",
    niche: refusalDirection || "Без кв.",
    service: refusalService || "Без кв.",
    preferredTime: latestTime,
    comment: latestComment,

    refusalReason,
    reason: refusalReason,
    lastClientMessage: refusalLast,
    last: refusalLast,
    waited: waited || "",
    rawText,
    createdAt: new Date().toISOString()
  };

  try {
    const resp = await axios.post(CRM_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json", "X-CRM-SECRET": CRM_WEBHOOK_SECRET },
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024
    });
    console.log("✅ CRM refusal: отправлена карточка отказа, статус " + resp.status);
    return { ok: true };
  } catch (e) {
    console.error("❌ CRM refusal send error:", e.response?.data || e.message);
    return { ok: false, error: e.response?.data || e.message };
  }
}

// ── Leads ────────────────────────────────────────────────────
async function getClientContext(phone) {
  if (!phone) return null;
  const r = await pool.query(`
    SELECT raw, date, daily_number FROM leads
    WHERE phone=$1 AND bot=$2 ORDER BY date DESC LIMIT 1
  `, [phone, BOT_NAME]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  const raw = row.raw || "";
  const cityMatch = raw.match(/Город\s*:\s*([^\n]+)/i);
  const serviceMatch = raw.match(/Услуга\s*:\s*([^\n]+)/i);
  const dateStr = row.date ? new Date(row.date).toLocaleDateString("ru-RU") : "";
  return {
    hasOrder: true,
    city: cityMatch ? cityMatch[1].trim() : "",
    service: serviceMatch ? serviceMatch[1].trim() : "",
    date: dateStr,
    dailyNumber: row.daily_number,
  };
}

async function saveLead(phone, replyText) {
  let leadLine = replyText.split("[ЗАЯВКА]")[1]?.trim() || "";
  const lines = leadLine.split("\n");
  const fieldLines = [];
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) { if (fieldLines.length > 0) break; continue; }
    if (/^[А-Яа-яA-Za-z][^:]*:/.test(trimmed)) fieldLines.push(trimmed);
    else if (fieldLines.length > 0) break;
  }
  let cleanLead = fieldLines.join("\n");
  cleanLead = cleanLead.replace(/^Комментарий:\s*[Кк]лиент из WhatsApp\.?\s*$/gim, "Комментарий: —");

  // Защита от дублей за 30 мин (только свой бот)
  const recent = await pool.query(`
    SELECT id, daily_number FROM leads
    WHERE phone=$1 AND bot=$2 AND type='lead' AND date > NOW() - INTERVAL '30 minutes'
    ORDER BY date DESC LIMIT 1
  `, [phone, BOT_NAME]);

  if (recent.rows[0]) {
    // Заявка уже оформлена в этом диалоге — НЕ обновляем и НЕ шлём ничего в группу.
    // Все доуточнения клиент согласует напрямую с менеджером.
    const { daily_number } = recent.rows[0];
    console.log(`⏭️ Доуточнение по заявке №${daily_number} от ${phone} — карточка НЕ обновляется (согласует менеджер)`);
    return;
  }

  // Новая заявка — нумерация раздельная по боту
  const today = getAlmatyDate();
  const maxR = await pool.query(`
    SELECT COALESCE(MAX(daily_number), 0) AS maxnum FROM leads
    WHERE bot=$1 AND type IN ('lead','callback')
      AND date AT TIME ZONE 'Asia/Almaty' >= $2::date
      AND date AT TIME ZONE 'Asia/Almaty' < ($2::date + INTERVAL '1 day')
  `, [BOT_NAME, today]);
  let todayCount = (maxR.rows[0].maxnum || 0) + 1;

  const ins = await pool.query(`
    INSERT INTO leads (phone, raw, type, bot, daily_number, date)
    VALUES ($1, $2, 'lead', $3, $4, NOW()) RETURNING id
  `, [phone, cleanLead, BOT_NAME, todayCount]);
  const globalId = ins.rows[0].id;

  console.log(`✅ Новая заявка #${globalId} (№${todayCount} за сегодня) от ${phone}`);
  notifyNewLead(phone, cleanLead, todayCount, globalId);
  await sendLeadToCrm(phone, cleanLead, todayCount, globalId, "new_lead");
}

async function saveCallback(phone, replyText) {
  // Извлекаем тело [ПОЗВОНИТЬ]
  let body = replyText.split("[ПОЗВОНИТЬ]")[1]?.trim() || "";
  const lines = body.split("\n");
  const fieldLines = [];
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) { if (fieldLines.length > 0) break; continue; }
    if (/^[А-Яа-яA-Za-z][^:]*:/.test(trimmed)) fieldLines.push(trimmed);
    else if (fieldLines.length > 0) break;
  }
  const cleanBody = fieldLines.join("\n");

  // СТРАХОВКА ОТ ДУБЛЯ: если по клиенту недавно (30 мин) уже оформлена ЗАЯВКА,
  // то «позвонить перед выездом» и прочие добавки НЕ создают карточку и НЕ обновляют заявку.
  // Клиент согласует детали напрямую с менеджером.
  try {
    const recentLead = await pool.query(`
      SELECT id, daily_number FROM leads
      WHERE phone=$1 AND bot=$2 AND type='lead' AND date > NOW() - INTERVAL '30 minutes'
      ORDER BY date DESC LIMIT 1
    `, [phone, BOT_NAME]);
    if (recentLead.rows[0]) {
      console.log(`⏭️ Доп. пожелание от ${phone} после заявки №${recentLead.rows[0].daily_number} — ничего не создаём (согласует менеджер)`);
      return;
    }
  } catch (e) {
    console.error("saveCallback recent-lead check error:", e.message);
  }

  // Иначе — обычный запрос на звонок без предшествующей заявки.
  const recent = await pool.query(`
    SELECT id FROM leads
    WHERE phone=$1 AND bot=$2 AND type='callback' AND date > NOW() - INTERVAL '30 minutes'
    LIMIT 1
  `, [phone, BOT_NAME]);
  if (recent.rows[0]) {
    console.log(`⚠️ Повторный callback от ${phone} — игнорируем`);
    return;
  }

  const today = getAlmatyDate();
  const maxR2 = await pool.query(`
    SELECT COALESCE(MAX(daily_number), 0) AS maxnum FROM leads
    WHERE bot=$1 AND type IN ('lead','callback')
      AND date AT TIME ZONE 'Asia/Almaty' >= $2::date
      AND date AT TIME ZONE 'Asia/Almaty' < ($2::date + INTERVAL '1 day')
  `, [BOT_NAME, today]);
  let todayCount = (maxR2.rows[0].maxnum || 0) + 1;

  const insCb = await pool.query(`
    INSERT INTO leads (phone, raw, type, bot, daily_number, date)
    VALUES ($1, $2, 'callback', $3, $4, NOW()) RETURNING id
  `, [phone, cleanBody, BOT_NAME, todayCount]);
  const globalIdCb = insCb.rows[0].id;

  console.log(`📞 Запрос на звонок №${todayCount} от ${phone}`);
  notifyCallback(phone, cleanBody, todayCount, globalIdCb);
}

async function saveComplaint(phone, replyText) {
  const line = replyText.split("[ЖАЛОБА]")[1]?.trim() || "";
  await pool.query("INSERT INTO complaints (phone, raw, bot) VALUES ($1, $2, $3)", [phone, line, BOT_NAME]);
  console.log("🚨 ЖАЛОБА от", phone);

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN) return;

  const phoneClean = (phone || "").replace(/[^\d]/g, "");
  const cityMatch = line.match(/Город\s*:\s*([^\n]+)/i);
  const city = (cityMatch ? cityMatch[1].trim() : "").toLowerCase();
  const text = `🚨🚨 СРОЧНО — ЖАЛОБА\n📞 Источник: ${SOURCE_NUMBER}\n📱 Телефон: +${phoneClean}\n\n${line}\n\nСвяжитесь немедленно!`;

  if (city.startsWith("алмат")) {
    axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: 5688798467,
      text,
    }).catch(e => console.error("TG complaint Khalid:", e.message));
  } else if (city.startsWith("астан") || city.startsWith("нур-сул")) {
    axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: 628333330,
      text,
    }).catch(e => console.error("TG complaint Kirill:", e.message));
  } else {
    if (TG_CHAT) {
      axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        text,
      }).catch(e => console.error("TG complaint group:", e.message));
    }
  }
}

// ── Telegram уведомления ─────────────────────────────────────
async function notifyNewLead(phone, leadLine, dailyNumber, globalId) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: formatCard("НОВАЯ ЗАЯВКА", phone, leadLine, dailyNumber, globalId),
    });
  } catch (e) { console.error("TG notify error:", e.message); }
}

async function notifyLeadUpdate(phone, leadLine, dailyNumber) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: formatCard("ОБНОВЛЕНИЕ ЗАЯВКИ", phone, leadLine, dailyNumber),
    });
  } catch (e) { console.error("TG update error:", e.message); }
}

async function notifyCallback(phone, body, dailyNumber, globalId) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT) return;
  const phoneClean = (phone || "").replace(/[^\d]/g, "");
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: `📞 ПОЗВОНИТЬ КЛИЕНТУ${globalId ? ' #' + globalId : ''}\n\n📋 Запрос №${dailyNumber} за сегодня\n📞 Источник: ${SOURCE_NUMBER}\n📱 Телефон: +${phoneClean}\n\n${body}\n\n⚠️ Бот не смог закрыть вопрос`,
    });
  } catch (e) { console.error("TG callback error:", e.message); }
}

const SEND_FN = (phone, text) => sendWhatsApp(phone, text);


function isExplicitNo(text) {
  const t = (text || "").trim().toLowerCase().replace(/[.!)\s]+$/g, "");
  return ["нет","не","пока нет","не надо","не нужно","спасибо","спс","ок","окей","хорошо","не интересно","жоқ","рахмет"].includes(t);
}

// ── Follow-up + умный отказ ──────────────────────────────────
const REASON_CANON = ["Дорого","Мониторинг","Не отвечает","Нету мастера","Не наш профиль","Клиент передумал","Перенос на другой день","Нашли другого исполнителя","Не хочет платить за замеры"];

function canonReason(s) {
  if (!s) return "Клиент передумал";
  const exact = REASON_CANON.find(c => c.toLowerCase() === s.toLowerCase().trim());
  if (exact) return exact;
  const sl = s.toLowerCase();
  // нечёткое сопоставление по ключевым словам
  if (/дорог|цена|дешевл|стоит/.test(sl)) return "Дорого";
  if (/монитор|прицен|узна|собира|просто спр|интересу/.test(sl)) return "Мониторинг";
  if (/не отвеч|молч|пропал|игнор|не выш|не дошёл|не дошел|тишин/.test(sl)) return "Не отвечает";
  if (/нет мастер|нету мастер|не работа.*город|вне покрыт|город вне/.test(sl)) return "Нету мастера";
  if (/не наш профил|не делаем|не занима|не та услуг/.test(sl)) return "Не наш профиль";
  if (/передума|раздума|отказа|не нужно|не надо/.test(sl)) return "Клиент передумал";
  if (/перенёс|перенес|на другой день|позже|потом|отлож/.test(sl)) return "Перенос на другой день";
  if (/друг.*исполнит|друг.*мастер|конкурент|нашли друг|уже заказа|уже купил|у других/.test(sl)) return "Нашли другого исполнителя";
  if (/замер|за выезд|платн.*замер/.test(sl)) return "Не хочет платить за замеры";
  return "Клиент передумал";
}

const SERVICE_CANON = ["Москитные сетки","Ремонт окон","Изготовление окон","Ролл шторы / Жалюзи","Сетки самовывоз","Защита от выпадения детей","Кованые решётки (антивор)","Плиссе","Ремонт стиральных машин","Ремонт холодильников","Ремонт посудомоечных машин","Установка/ремонт вытяжек","Установка/ремонт кондиционеров","Сварка","Металлоконструкции","Электрика","Клининг","Мебель на заказ","Без кв."];

function canonService(s) {
  if (!s) return "Без кв.";
  const exact = SERVICE_CANON.find(c => c.toLowerCase() === s.toLowerCase().trim());
  if (exact) return exact;
  const sl = s.toLowerCase();
  const hit = SERVICE_CANON.find(c => c !== "Без кв." && sl.includes(c.toLowerCase().split(" ")[0]));
  return hit || "Без кв.";
}

function followupText(direction, service) {
  if (direction === "Без кв.") return null; // не шлём вслепую
  if ((service || "").toLowerCase().includes("клининг"))
    return "Если ещё актуально — посчитаю стоимость уборки прямо в переписке, это быстро. Подскажете площадь и тип уборки? 😊";
  if (direction === "Мебель")
    return "Если думаете — давайте оформлю заявку, дизайнер свяжется, бесплатно проконсультирует и рассчитает по вашему проекту. Оформить? 😊";
  if (direction === "Окна")
    return "Если думаете над ценой — замер бесплатный, ни к чему не обязывает. Мастер подскажет точную сумму на месте. Записать на удобное время? 😊";
  if (direction === "Сервис")
    return "Если ещё актуально — мастер бесплатно приедет и оценит, назовёт точную цену на месте. Удобно записать? 😊";
  return "Если ещё актуально — подскажите, помогу оформить заявку 😊";
}

// Анализ диалога для follow-up и отказа (второй вызов Claude, с мягкой деградацией)
async function analyzeDialog(phone) {
  const hist = await loadHistory(phone);
  if (!hist.length) return { direction: "Без кв.", service: "Без кв.", reason: "нет диалога", last: "—" };
  const transcript = hist.slice(-12).map(m => {
    const who = m.role === "user" ? "Клиент" : "Бот";
    const txt = typeof m.content === "string" ? m.content : "[медиа]";
    return who + ": " + txt;
  }).join("\n");
  const lastUser = hist.filter(m => m.role === "user").slice(-1)[0];
  const lastText = lastUser && typeof lastUser.content === "string" ? lastUser.content : "[медиа]";

  const sys = "Проанализируй диалог клиента с ботом сервиса бытовых услуг. Верни СТРОГО 4 строки и ничего больше:\nНаправление: <Окна|Сервис|Мебель|Без кв.>\nУслуга: <одно значение из списка: " + SERVICE_CANON.join(", ") + ">\nПричина: <СТРОГО одно значение из списка: " + REASON_CANON.join(", ") + ">\nПоследнее: <последнее сообщение клиента>\n\nПРАВИЛА ОПРЕДЕЛЕНИЯ ПРИЧИНЫ (важно):\n1. Если клиент САМ назвал причину словами ('нашли других', 'дорого', 'передумал', 'уже купил', 'далеко', 'долго') — бери ЭТУ причину дословно по смыслу, НЕ придумывай свою.\n2. НЕ вини бота за 'долгое уточнение' или 'много вопросов', если паузы в диалоге делал сам клиент, а бот отвечал по делу. Различай: клиент ушёл сам (потерял интерес, нашёл другого, медлил с ответом) ПРОТИВ бот оттолкнул (запутал, нагрубил). По умолчанию считай, что причина на стороне клиента, если нет явных признаков ошибки бота.\n3. 'Нашли других' / 'уже заказали' = ушёл к конкуренту. 'Дорого' / 'сколько' без заказа = цена. Молчит без слов = передумал/не дошёл.\n4. «Не отвечает» выбирай ТОЛЬКО как крайний случай: если клиент с самого начала почти не отвечал и не дал НИКАКОГО сигнала (ни услуги, ни цены, ни сомнения). Если клиент общался, а потом замолчал — выбери содержательную причину (Клиент передумал / Дорого / Нашли другого исполнителя / Перенос на другой день), НЕ «Не отвечает».\n\nЕсли непонятно направление или услуга — ставь 'Без кв.'. Услуга — ТОЛЬКО из списка, без деталей.";

  try {
    const r = await axios.post("https://api.anthropic.com/v1/messages", {
      model: MODEL, max_tokens: 200, system: sys,
      messages: [{ role: "user", content: transcript }],
    }, { headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
    const txt = r.data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const f = (n) => { const m = txt.match(new RegExp(n + "\\s*:\\s*([^\\n]*)", "i")); return m ? m[1].trim() : ""; };
    return {
      direction: f("Направление") || "Без кв.",
      service: canonService(f("Услуга")),
      reason: canonReason(f("Причина")),
      last: f("Последнее") || lastText,
    };
  } catch (e) {
    console.error("analyzeDialog error:", e.message);
    return { direction: "Без кв.", service: "Без кв.", reason: "Не отвечает", last: lastText };
  }
}

async function sendFollowup(phone) {
  if (followupSent[phone]) return false; // уже слали — не повторяем
  const hist = await loadHistory(phone);
  const lastUser = hist.filter(m => m.role === "user").slice(-1)[0];
  const lastTxt = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
  if (isExplicitNo(lastTxt)) return false; // клиент явно отказал — не доставать
  const a = await analyzeDialog(phone);
  const text = followupText(a.direction, a.service);
  if (!text) return false; // Без кв. — follow-up не шлём
  followupSent[phone] = true;
  await SEND_FN(phone, text);
  console.log("📨 Follow-up отправлен " + phone + " (" + a.direction + ")");
  return true;
}

function isThanksClose(text) {
  if (!text) return false;
  if (/[?]/.test(text)) return false;
  if (/скольк|цена|стоит|когда|перезвон|номер|адрес|сделае|можно ли|а если|ещё|еще/i.test(text)) return false;
  const t = text.toLowerCase().replace(/[^а-яёa-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 30) return false;
  return /спасибо|благодар/.test(t) || /(^| )спс( |$)/.test(t) || /договорились|до свидания|всего доброго|всё понятно|все понятно/.test(t);
}

async function notifyRefusal(phone, waited) {
  const a = await analyzeDialog(phone);
  if (isThanksClose(a.last)) { console.log("⏭️ отказ пропущен — клиент попрощался:", phone, "|", a.last); return; }

  // ДЕДУП ОТКАЗА: отказ фиксируется ОДИН раз на клиента.
  // 1) если по клиенту уже был отказ (когда-либо) — повторный НЕ создаём;
  // 2) если по клиенту недавно (7 дней) была жалоба — дело уже у людей, отказ НЕ создаём.
  // Если клиент снова пишет — это обработается как новая заявка/жалоба обычным потоком (askClaude),
  // а НЕ как ещё один отказ.
  try {
    const prevRef = await pool.query(
      "SELECT 1 FROM leads WHERE phone=$1 AND bot=$2 AND type='refusal' LIMIT 1",
      [phone, BOT_NAME]
    );
    if (prevRef.rowCount > 0) {
      console.log("⏭️ отказ пропущен — по клиенту уже зафиксирован отказ:", phone);
      return;
    }
    const prevCompl = await pool.query(
      "SELECT 1 FROM complaints WHERE phone=$1 AND bot=$2 AND date > NOW() - INTERVAL '7 days' LIMIT 1",
      [phone, BOT_NAME]
    );
    if (prevCompl.rowCount > 0) {
      console.log("⏭️ отказ пропущен — по клиенту есть недавняя жалоба:", phone);
      return;
    }
  } catch (e) {
    console.error("refusal dedup check error:", e.message);
    // при ошибке проверки фиксируем как раньше (видимость важнее), 1-часовая защита в таймере остаётся
  }
  let refusalGlobalId = null;
  try {
    const raw = "Направление: " + a.direction + "\nУслуга: " + a.service + "\nПричина: " + a.reason + "\nПоследнее: " + (a.last || "—");
    const insRef = await pool.query("INSERT INTO leads (phone, raw, type, bot, date) VALUES ($1, $2, 'refusal', $3, NOW()) RETURNING id", [phone, raw, BOT_NAME]);
    refusalGlobalId = insRef.rows[0].id;
  } catch (e) { console.error("save refusal error:", e.message); }

  await sendRefusalToCrm(phone, a, waited, refusalGlobalId);

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT) return;
  const phoneClean = (phone || "").replace(/[^\d]/g, "");
  // имя/адрес берём из последней заявки клиента; в диалоге отказника их часто нет — не выдумываем
  let refName = "неизвестно", refAddr = "неизвестно";
  try {
    const _rl = await pool.query("SELECT raw FROM leads WHERE phone=$1 AND bot=$2 AND type='lead' ORDER BY date DESC LIMIT 1", [phone, BOT_NAME]);
    if (_rl.rows[0]) {
      refName = fieldFrom(_rl.rows[0].raw, "Имя") || "неизвестно";
      refAddr = fieldFrom(_rl.rows[0].raw, "Адрес") || "неизвестно";
    }
  } catch (e) { console.error("refusal name/addr lookup error:", e.message); }
  let t = "🔴 ОТКАЗ" + (refusalGlobalId ? " #" + refusalGlobalId : "") + "\n\n";
  t += "📞 Источник: " + SOURCE_NUMBER + "\n";
  t += "👤 Имя: " + refName + "\n";
  t += "📱 Телефон: +" + phoneClean + "\n";
  t += "📍 Адрес: " + refAddr + "\n";
  t += "🔧 Направление: " + a.direction + "\n";
  t += "🛠 Услуга: " + a.service + "\n";
  t += "💡 Причина (гипотеза): " + a.reason + "\n";
  t += "💬 Последнее: «" + (a.last || "—").substring(0, 200) + "»\n";
  t += "⏱ " + waited;
  try {
    await axios.post("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", { chat_id: TG_CHAT, text: t });
  } catch (e) { console.error("TG refusal error:", e.message); }
}

// ── Вспомогательные функции времени ─────────────────────────
function getAlmatyDate(d = new Date()) {
  const almaty = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return almaty.toISOString().slice(0, 10);
}
function getAlmatyHM(d = new Date()) {
  const almaty = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return { h: almaty.getUTCHours(), m: almaty.getUTCMinutes() };
}

// ── System prompt ────────────────────────────────────────────
function buildSystemPrompt(clientCtx, knowledge) {
  let contextBlock = "";
  if (clientCtx && clientCtx.hasOrder) {
    contextBlock = `

КОНТЕКСТ КЛИЕНТА (внутренняя информация для тебя)
Этот клиент УЖЕ оформлял заявку у нас:
- Дата заявки: ${clientCtx.date}
- Город: ${clientCtx.city || "не указан"}
- Услуга: ${clientCtx.service || "не указана"}

ВАЖНО:
- Город клиента ты ЗНАЕШЬ из его предыдущей заявки. НЕ переспрашивай «в каком вы городе».
- Если он спрашивает про статус или хочет ОТМЕНИТЬ заявку — сразу дай ПРЯМОЙ телефон менеджера по его городу.
- Не выдумывай детали заказа — ты знаешь только сам факт заявки.

`;
  }
  return `Ты — Юрий, опытный консультант компании OKNA PLAST в Казахстане.
Ты общаешься с клиентами в WhatsApp как живой человек, а не как робот.
Твоя задача — помочь клиенту и довести до заявки на замер или вызов мастера.${contextBlock}

САМОЕ ПЕРВОЕ СООБЩЕНИЕ — ЖЁСТКОЕ ПРАВИЛО
Твой САМЫЙ первый ответ в диалоге ВСЕГДА начинается с приветствия, ДАЖЕ если клиент сразу написал размеры, количество, задачу или вопрос. Сначала поздоровайся и представься, и только потом — по делу.
Первая строка первого ответа ВСЕГДА: «Здравствуйте! Я Юрий, консультант OKNA PLAST 😊»
Дальше в этом же сообщении можешь сразу ответить по сути (задать уточняющий вопрос или повести на замер).
Пример: клиент пишет «129х52 - 1 шт» → ты: «Здравствуйте! Я Юрий, консультант OKNA PLAST 😊 По размерам сориентирует мастер на бесплатном замере. В каком вы городе?»
Больше НИКОГДА не здоровайся и не представляйся повторно — только в первом сообщении.

ПРАВИЛО КРАТКОСТИ — АБСОЛЮТНЫЙ ПРИОРИТЕТ
- Каждый ответ — максимум 2-3 строки. Никогда не больше.
- Одно сообщение = одна мысль + максимум один вопрос.
- Никогда не объясняй то, о чём клиент не спрашивал.
- Не повторяй вопрос если клиент уже ответил — даже частично.
- Если клиент назвал количество — не уточняй количество повторно.
- Никогда не пиши маркированные списки с буллетами (•, -, *) — только обычный текст.
- Скидку упоминай один раз вскользь — не делай из неё отдельный абзац.

О КОМПАНИИ
OKNA PLAST — изготовление и установка окон, москитных сеток, решёток, ремонт окон и пластиковых дверей (регулировка, замена уплотнителя) по Казахстану. Гарантия 12 месяцев, выезд в день обращения. Замер сеток, решёток и ремонта бесплатный; замер для изготовления окон — платный (см. ниже).

МЕНЕДЖЕРЫ ПО ОКНАМ (выдавать только после оформления / при вопросе о статусе)
- Алматы → Халид +7 747 654 7980
- Астана → Кирилл +7 747 614 6768
- Караганда → Сеймур +7 775 242 2122
- Любой другой город → Владимир/Татьяна +7 777 406 6011. ВАЖНО: на этом номере НЕТ WhatsApp — клиенту говори «позвоните по номеру», НЕ «напишите».
НИКОГДА не давай номера менеджеров при первичном обращении.
Если клиент просит номер сразу: «Менеджер перезвонит сам после оформления заявки. Какой номер для связи?»

ИСКЛЮЧЕНИЕ 1 — КЛИЕНТ УЖЕ ОФОРМИЛ И: спрашивает про установку/мастера, ИЛИ просит «свяжите с менеджером», «дайте контакт», «номер менеджера», «как связаться»:
Бери город из контекста и выдай ПРЯМОЙ номер: Алматы → Халид +7 747 654 7980, Астана → Кирилл +7 747 614 6768, Караганда → Сеймур +7 775 242 2122, остальные города → Владимир/Татьяна +7 777 406 6011 (только ЗВОНОК, WhatsApp нет — говори «позвоните»).
Формат: «Вот прямой номер менеджера по [город]: [номер] ([имя]). Можете связаться сами.»
ВАЖНО: номер давай ТОЛЬКО если заявка в этом диалоге уже оформлена. Если заявки нет — сначала оформи [ЗАЯВКА]. После выдачи — не продолжай.

ИСКЛЮЧЕНИЕ 2 — КЛИЕНТ ОТМЕНЯЕТ:
«Понял.» + контакт по городу (или «скоро свяжемся» для других городов). Не уговаривай.

ГЕОГРАФИЯ ПО ОКОННОМУ НАПРАВЛЕНИЮ: работаем по ВСЕМУ Казахстану — все города. Никогда не отказывай по городу. Алматы, Астана, Шымкент, Караганда, Актобе, Атырау, Тараз, Усть-Каменогорск, Семей, Кокшетау, Костанай, Павлодар, Уральск, Кызылорда, Туркестан, Талдыкорган и любой другой город KZ.

МИНИМАЛЬНЫЙ ЗАКАЗ — 2 СЕТКИ (только на окна)
Если одно окно: «На окна минимум 2 сетки — есть ещё окна?» Не объясняй почему.
На ДВЕРИ (входная, балконная дверь, террасная) — выезжаем на 1 штуку.

БАЛКОН — ОБЯЗАТЕЛЬНО УТОЧНЯТЬ
Если клиент говорит «сетка на балкон» — одной строкой:
«На саму балконную дверь или на окна балконного остекления?»

ПЛАСТИКОВАЯ ДВЕРЬ ДУЕТ / ПРОДУВАЕТ — ЭТО НАШ РЕМОНТ, НЕ ОТКАЗЫВАЙ
Если клиент пишет, что пластиковая дверь (балконная, входная, террасная, межкомнатная пластиковая) дует, продувает, сквозит, плохо закрывается, провисла или не прилегает — это РЕМОНТ, и мы это ДЕЛАЕМ (регулировка, замена уплотнителя — то же, что на окнах). КАТЕГОРИЧЕСКИ НЕ говори «ремонтом дверей не занимаемся».
Действуй так: «Это решается — чаще всего дело в уплотнителе или регулировке. Мастер бесплатно приедет, посмотрит и устранит. В каком вы городе?» → доведи до [ЗАЯВКА]: Направление «Окна», Услуга «Ремонт окон», в Комментарий — «пластиковая дверь продувает» + детали клиента.
Отказывай ТОЛЬКО если речь явно про НЕпластиковое: деревянная или металлическая дверь, врезка/замена замка, новое дверное полотно — этого мы не делаем. Тогда не руби сразу: вежливо предложи альтернативу (москитная сетка или плиссе на дверной проём) и спроси, подойдёт ли.

ПЛИССЕ / РАЗДВИЖНЫЕ
Если клиент пишет «раздвижные сетки» — для нас это ПЛИССЕ, веди как плиссе, не уточняй разницу.
Плиссе от 25 000 тг — гармошка на любые проёмы, двери, балконы, панорамные окна.
Плиссе НЕ является защитой от выпадения детей — это только от насекомых и пыли.

ПРЕДОПЛАТА
«Предоплата от 70%, точную сумму мастер согласует после замера.»
Не объясняй зачем нужна предоплата.

ЦЕНЫ
Стандартные сетки от 7 000 тг, антикошка от 12 000, антимошка от 15 000, антипыль от 18 000, ультравью от 22 000, плиссе от 25 000.
Решётки поликарбонат от 25 000, алюминий от 15 000.
Ремонт окон от 2 500 тг. Окна — после замера.

КРИТИЧЕСКИ ВАЖНО ПО ЦЕНАМ:
- НИКОГДА не называй цену за конкретный размер окна.
- Если клиент называет размер и просит цену: «Точную цену назовёт мастер на замере — он бесплатно приедет. Записать вас?»
- Не прикидывай, не давай диапазон по размеру. Никогда.

ЕСЛИ КЛИЕНТ ПРОСИТ ПРАЙС:
Одной строкой: «Сетки от 7 000 тг, антикошка от 12 000, антимошка от 15 000, антипыль от 18 000. Точная цена — после замера, он бесплатный. Записать?»

ИЗГОТОВЛЕНИЕ И УСТАНОВКА ОКОН (пластиковые окна на заказ) — ОСОБЫЙ СЦЕНАРИЙ:
По окнам действуй как по проекту:
→ Сначала спроси: «У вас есть готовый проект, чертёж или размеры окон?»
→ ЕСЛИ ЕСТЬ (есть размеры/чертёж/референс): оформи [ЗАЯВКА], услуга «Изготовление окон», все размеры и детали — в Комментарий, добавь «есть размеры/проект, передать менеджеру на расчёт». Менеджер свяжется и посчитает. Цену сам НЕ называй.
→ ЕСЛИ НЕТ размеров: предложи выезд замерщика за 10 000 тг. Скажи: «Замер окон у нас платный — 10 000 тг, но при заключении договора эта сумма вычитается из стоимости. Мастер приедет, точно замерит и рассчитает. Оформляем?» Если согласен — собери имя, телефон, город, адрес и оформи [ЗАЯВКА], услуга «Изготовление окон», в Комментарий «нужен платный замер 10 000».
→ Это правило про платный замер 10 000 относится ТОЛЬКО к изготовлению/установке пластиковых окон. На сетки, плиссе, решётки и ремонт окон замер БЕСПЛАТНЫЙ — там действуй как обычно.

КАК ВЕСТИ ДИАЛОГ
1. Сразу закрывай на замер. «Нужна сетка» → «Мастер бесплатно приедет и подберёт. В каком вы городе?» «Нужна сетка» → «Мастер бесплатно приедет и подберёт. В каком вы городе?»
2. Типы сеток — только если клиент сам спросил «какие есть варианты».
3. Контактные данные собирай один раз в конце.
4. Один вопрос за раз.

УСТАНОВКА ВХОДИТ В ЦЕНУ (важно)
Монтаж/установка уже включён в стоимость любой сетки, окна, решётки — отдельно НЕ оплачивается.
- Если клиент спрашивает «установка отдельно?» / «под ключ от скольки?» → «Установка уже включена в цену, отдельно не оплачивается.»
- Если клиент хочет установить сам → «Хорошо, без проблем. Цена та же — установка входит в стоимость.» Не отговаривай, не настаивай.

ВРЕМЯ ЗАМЕРА
Не спрашивай «утром, днём или вечером?» — запрещено.
Если клиент не назвал время — пиши «Время: по согласованию с менеджером».
НИКОГДА не говори «завтра» или «на следующий день» — выезд всегда в день обращения. Перенос только если клиент сам попросит.

ГОЛОСОВОЕ / МЕДИА
Одной строкой: «Голосовые не читаю 🙏 Напишите текстом или оставьте номер — менеджер перезвонит.»

КЛИЕНТ ХОЧЕТ СВЯЗАТЬСЯ С МЕНЕДЖЕРОМ / ЧЕЛОВЕКОМ / ОПЕРАТОРОМ
Если клиент просит «свяжите с менеджером», «дайте оператора», «хочу поговорить с человеком», «перезвоните», «позвоните мне» — действуй по ОДНОМУ правилу:
1. Ответь: «Конечно, свяжу вас с менеджером — давайте только оформлю заявку, чтобы он сразу был в курсе.»
2. Собери что не хватает (имя, телефон, город, суть) и оформи [ЗАЯВКА].
3. СРАЗУ ПОСЛЕ заявки дай прямой номер менеджера по городу: Алматы → Халид +7 747 654 7980, Астана → Кирилл +7 747 614 6768, Караганда → Сеймур +7 775 242 2122, остальные города → Владимир/Татьяна +7 777 406 6011 (только ЗВОНОК, WhatsApp нет — говори «позвоните»).
   Формат: «Готово! Вот прямой номер менеджера: [номер] ([имя]) — можете связаться сами 😊»
НИКОГДА не обещай «оператор перезвонит» — всегда давай номер сам после заявки.
Если клиент наотрез не даёт данные (только голосовые, не называет имя/номер) — дай общий номер: колл-центр +7 777 406 60 11.

ЮР.ЛИЦА — через [ЗАЯВКА] на замер. Если просят КП/тендер/договор без выезда — оформи [ЗАЯВКА] с пометкой в комментарии «нужно КП», менеджер свяжется.

ЖАЛОБЫ
Смени тон, без смайлов: «Извините за ситуацию, разберёмся.»
[ЖАЛОБА]
Имя: ...
Телефон: ...
Город: ...
Тезис: <одна короткая строка 5-10 слов: суть проблемы>
Суть: ...
«Передал руководителю, свяжутся с вами.»

ЕСЛИ ЖАЛОБА В ТОМ, ЧТО ПОСЛЕ ЗАЯВКИ С КЛИЕНТОМ НЕ СВЯЗАЛИСЬ — не отправляй его просто ждать звонка (он уже один раз не дождался). Сразу после блока [ЖАЛОБА] дай ПРЯМОЙ номер менеджера по окнам по его городу: Алматы → Халид +7 747 654 7980, Астана → Кирилл +7 747 614 6768, Караганда → Сеймур +7 775 242 2122, остальные города → Владимир/Татьяна +7 777 406 6011 (только звонок, WhatsApp нет). Это работает ДАЖЕ если заявка была оформлена раньше или в другом обращении — правило «только в этом диалоге» здесь не действует.
Формат: «Чтобы не ждать — вот прямой номер менеджера по [город]: [номер] ([имя]), можете позвонить сами 🙏».

СБОР ЗАЯВКИ
[ЗАЯВКА]
Имя: ...
Телефон: ...
Город: ...
Адрес: ...
Направление: ...
Услуга: ...
Время: ...
Комментарий: ...

ПОЛЕ «Направление» — ОБЯЗАТЕЛЬНО. Почти всегда это «Окна» (сетки, плиссе, решётки/защита детей, ремонт окон, установка окон). Ставь:
- «Окна» — москитные сетки, плиссе, решётки/защита детей, ремонт окон, установка окон.
- «Без кв.» — только если запрос совсем не про окна и непонятен. Тогда суть — в Комментарий.

В «Услуга» — СТРОГО одно значение из справочника, БЕЗ деталей: «Москитные сетки», «Плиссе», «Защита от выпадения детей», «Ремонт окон», «Изготовление окон», «Ролл шторы / Жалюзи», «Сетки самовывоз», «Кованые решётки (антивор)».
ЗАПРЕЩЕНО писать в Услугу количество и детали («на 3 окна», «стандарт», «на балкон»). Всё это — в Комментарий.
Пример ПРАВИЛЬНО: Услуга: Москитные сетки / Комментарий: 4 окна, стандарт.
Пример НЕПРАВИЛЬНО: Услуга: Москитные сетки стандарт на 4 окна.
В «Комментарий» — только важное для мастера (этаж, тип сетки, особенности). Если нечего — «—».
ПОСЛЕ [ЗАЯВКА] — НИЧЕГО НЕ ПИШИ. Заявка = последнее слово. Точка.

ЗАЯВКА УЖЕ ОФОРМЛЕНА В ЭТОМ ДИАЛОГЕ — ЧТО ДЕЛАТЬ ДАЛЬШЕ:
Если клиент ПОСЛЕ оформленной заявки что-то добавляет, уточняет или просит (например «позвоните перед выездом», «ещё нужно второе окно», «добавьте балкон», меняет время/адрес/количество) — НЕ выдавай [ЗАЯВКА] повторно и НЕ выдавай [ПОЗВОНИТЬ]. Заявка оформляется ОДИН раз за диалог.
Вместо этого коротко ответь клиенту: «Передал! Менеджер скоро свяжется — все детали (время, адрес, количество) согласуете напрямую с ним 😊» и больше никаких тегов не пиши.

НИКОГДА НЕ ПРИДУМЫВАЙ цены за размеры, акции, сроки которых нет в инструкциях.
Если не знаешь — «Точную информацию уточнит мастер на замере.»

ТЕЛЕФОН КЛИЕНТА

ТЕЛЕФОН — НИКОГДА НЕ ВЫДУМЫВАЙ
Если клиент сказал «этот номер», «я с этого пишу», «по этому номеру» или НЕ назвал цифры явно — в поле Телефон пиши РОВНО: «этот номер». НЕ сочиняй и не подставляй никакие цифры сам — система сама возьмёт номер WhatsApp.
Цифры в поле Телефон пиши ТОЛЬКО если клиент явно написал их в сообщении (например «87011234567»). Если не уверен — пиши «этот номер».

Если клиент пишет с WhatsApp — его номер уже известен системе. НЕ проси номер телефона повторно если клиент написал «этот номер» или «я же с этого пишу». Просто используй номер с которого пишет клиент и продолжай собирать заявку.

КАЗАХСКИЙ ЯЗЫК
Клиенты иногда пишут на казахском. Основные слова:
- «Зваданыз» / «Звоните» — означает «позвоните мне» → оформи [ЗАЯВКА] и дай номер менеджера
- «Сәлем» — привет, «Рахмет» — спасибо, «Иә»/«Ия» — да, «Жоқ» — нет
- «Қашан» — когда, «Қанша» — сколько
- «Маған қоңырау шалыңыз» — позвоните мне
Если клиент пишет на казахском — отвечай на русском, вежливо и кратко.

КЛИЕНТ ПРОСИТ ПОЗВОНИТЬ
Если клиент говорит «пусть позвонят», «позвоните мне», «хочу чтобы позвонили» — оформи [ЗАЯВКА] (номер бери с которого пишет клиент, имя если не знаешь — «не указано»), потом дай прямой номер менеджера по городу. Не обещай «перезвоним» — давай номер сам.

КОНТЕКСТ: не здоровайся заново. «Вы тут?» → «Да, на связи 😊»
ЗАВЕРШЕНИЕ: «Хорошо! Если понадобится — обращайтесь 😊»

ДОПОЛНИТЕЛЬНАЯ БАЗА ЗНАНИЙ:
${knowledge || "(пока пустая)"}
`;
}

// ── Claude API ───────────────────────────────────────────────
async function askClaude(userPhone, userMessage, imageBase64, imageMediaType) {
  const history = await loadHistory(userPhone);

  if (imageBase64) {
    history.push({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
        { type: "text", text: userMessage || "Клиент прислал фото." },
      ],
    });
  } else {
    history.push({ role: "user", content: userMessage });
  }

  const clientCtx = await getClientContext(userPhone);
  const knowledge = await loadKnowledge();

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(clientCtx, knowledge),
        messages: history.slice(-20),
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }
    );

    let reply = response.data.content
      .filter(b => b.type === "text")
      .map(b => b.text.trim())
      .filter(Boolean)
      .join("\n");

    // Дедупликация строк
    const seen = new Set();
    reply = reply.split("\n").filter(line => {
      const key = line.trim();
      if (key === "") return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join("\n");

    history.push({ role: "assistant", content: reply });
    await saveHistory(userPhone, history.slice(-40));

    if (reply.includes("[ПОЗВОНИТЬ]")) await saveCallback(userPhone, reply);
    else if (reply.includes("[ЗАЯВКА]")) await saveLead(userPhone, reply);
    if (reply.includes("[ЖАЛОБА]")) await saveComplaint(userPhone, reply);

    return reply;
  } catch (err) {
    console.error("Claude API error:", err.response?.data || err.message);
    return "Извините, небольшой сбой. Напишите ещё раз или оставьте номер — мастер перезвонит.";
  }
}

// ── WhatsApp отправка через Wazzup (с retry) ─────────────────
async function sendWhatsApp(to, text, attempt = 1) {
  try {
    await axios.post(
      `${WAZZUP_API_URL}/message`,
      {
        channelId: WAZZUP_CHANNEL_ID,
        chatType: "whatsapp",
        chatId: to,
        text,
      },
      {
        headers: {
          "Authorization": `Bearer ${WAZZUP_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error(`Wazzup send error (attempt ${attempt}):`, err.response?.data || err.message);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return sendWhatsApp(to, text, attempt + 1);
    }
  }
}

// ── Webhook (Wazzup) ─────────────────────────────────────────
const messageBuffers = {};
const processedIds = new Set();
const BUFFER_MS = 10000;

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    if (req.body.test === true) return;
    const messages = req.body.messages || [];
    for (const message of messages) {
      await handleMessage(message);
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

async function handleMessage(message) {
  if (message.isEcho === true) return;
  if (message.status && message.status !== "inbound") return;

  const messageId = message.messageId;
  if (messageId) {
    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
    if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);
  }

  if (message.channelId && message.channelId !== WAZZUP_CHANNEL_ID) {
    console.log(`⏭️ Игнорируем сообщение из другого канала: ${message.channelId}`);
    return;
  }

  const from = message.chatId;
  if (!from) return;

  const msgType = message.type || "text";

  if (msgType === "image") {
    await trackDialog(from);
    await handleImage(from, message);
    return;
  }

  if (msgType !== "text") {
    await sendWhatsApp(from, "Голосовые не читаю 🙏 Напишите текстом или оставьте номер — менеджер перезвонит.");
    return;
  }

  const text = message.text || "";
  if (!text.trim()) return;
  console.log(`📩 ${from}: ${text}`);

  const cmd = text.trim().toLowerCase();
  if (cmd === "/manager" || cmd === "/стоп") { await setPaused(from); return; }
  if (cmd === "/bot" || cmd === "/старт") { await setUnpaused(from); return; }
  if (cmd === "/status") {
    const paused = await isPaused(from);
    await sendWhatsApp(from, `Статус бота: ${paused ? "на паузе" : "активен"}`);
    return;
  }

  if (await isPaused(from)) { console.log(`🔇 ${from} на паузе`); return; }

  await trackDialog(from);
  bufferIncoming(from, text);
}

// ── Follow-up (15 мин) + отказ (ещё 25 мин) ──────────────────
const followupTimers = {};
const followupSent = {}; // кому follow-up уже слали (1 раз на клиента)
const FOLLOWUP_MS = 15 * 60 * 1000;
const REFUSAL_MS  = 25 * 60 * 1000;
const rejectTimers = {};

function resetRejectTimer(from) {
  if (rejectTimers[from]) { clearTimeout(rejectTimers[from]); delete rejectTimers[from]; }
  if (followupTimers[from]) { clearTimeout(followupTimers[from]); delete followupTimers[from]; }

  followupTimers[from] = setTimeout(async () => {
    delete followupTimers[from];
    try {
      const r = await pool.query("SELECT 1 FROM leads WHERE phone=$1 AND bot=$2 AND date > NOW() - INTERVAL '20 minutes' LIMIT 1", [from, BOT_NAME]);
      if (r.rowCount > 0) return;
      if (await isPaused(from)) return;
      await sendFollowup(from);
    } catch (e) { console.error("Followup timer error:", e.message); }

    rejectTimers[from] = setTimeout(async () => {
      delete rejectTimers[from];
      try {
        const r2 = await pool.query("SELECT 1 FROM leads WHERE phone=$1 AND bot=$2 AND date > NOW() - INTERVAL '1 hour' LIMIT 1", [from, BOT_NAME]);
        if (r2.rowCount > 0) return;
        await notifyRefusal(from, "молчит после follow-up (40 мин)");
        console.log("🔴 Отказ зафиксирован для " + from);
      } catch (e) { console.error("Refusal timer error:", e.message); }
    }, REFUSAL_MS);
  }, FOLLOWUP_MS);
}

// ── Буферы сообщений ─────────────────────────────────────────
function bufferIncoming(from, text) {
  if (!messageBuffers[from]) messageBuffers[from] = { parts: [], timer: null };
  const buf = messageBuffers[from];
  buf.parts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(async () => {
    const combined = buf.parts.join("\n").trim();
    delete messageBuffers[from];
    try {
      const reply = await askClaude(from, combined);
      await sendWhatsApp(from, reply);
      if (!reply.includes("[ЗАЯВКА]") && !reply.includes("[ПОЗВОНИТЬ]")) {
        resetRejectTimer(from);
      } else {
        if (rejectTimers[from]) { clearTimeout(rejectTimers[from]); delete rejectTimers[from]; }
        if (followupTimers[from]) { clearTimeout(followupTimers[from]); delete followupTimers[from]; }
        delete followupSent[from];
      }
    } catch (e) { console.error("Buffer reply error:", e.message); }
  }, BUFFER_MS);
}

// ── Обработка фото (Wazzup) ──────────────────────────────────
async function handleImage(from, message) {
  const caption = message.caption || "";
  const mediaUrl = message.contentUri || message.url || message.media?.url;

  if (!mediaUrl) {
    await sendWhatsApp(from, "Не получилось загрузить фото 🙏 Напишите размеры текстом — помогу.");
    return;
  }

  try {
    const imgResp = await axios.get(mediaUrl, {
      headers: { "Authorization": `Bearer ${WAZZUP_API_KEY}` },
      responseType: "arraybuffer",
      maxContentLength: 20 * 1024 * 1024,
    });
    const base64 = Buffer.from(imgResp.data).toString("base64");
    const mediaType = imgResp.headers["content-type"] || "image/jpeg";
    const userText = caption || "Клиент прислал фото — посмотри что на нём и помоги.";
    const reply = await askClaude(from, userText, base64, mediaType);
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error("Image error:", err.message);
    await sendWhatsApp(from, "Не получилось загрузить фото 🙏 Напишите размеры текстом — помогу.");
  }
}

// ── Суточный отчёт ───────────────────────────────────────────
function normCity(city) {
  if (!city) return "Не указан";
  const c = city.trim().toLowerCase();
  if (c.startsWith("алмат")) return "Алматы";
  if (c.startsWith("астан") || c.startsWith("нур-сул")) return "Астана";
  if (c.startsWith("шымкен")) return "Шымкент";
  if (c.startsWith("караган")) return "Караганда";
  if (c.startsWith("актоб")) return "Актобе";
  return city.trim().charAt(0).toUpperCase() + city.trim().slice(1).toLowerCase();
}
function normService(service) {
  const s = (service || "").toLowerCase();
  if (!s) return "Без кв.";
  if (/сетк|москит|плисс|антикошк|антимошк|антипыл|ультравью/.test(s)) return "Москитные сетки";
  if (/антивор/.test(s) || (/кован/.test(s) && /решёт|решет/.test(s))) return "Кованые решётки (антивор)";
  if (/решёт|решет|выпадени|защит/.test(s)) return "Защита от выпадения детей";
  if (/ремонт окон|регулировк|уплотнит|продув/.test(s)) return "Ремонт окон";
  if (/изготовлен.*окон|установк.*окон/.test(s)) return "Изготовление окон";
  if (/ролл|жалюз/.test(s)) return "Ролл шторы / Жалюзи";
  if (/кован/.test(s)) return "Кованые решётки (антивор)";
  if (/самовывоз/.test(s)) return "Сетки самовывоз";
  if (/стирал/.test(s)) return "Ремонт стиральных машин";
  if (/холодил/.test(s)) return "Ремонт холодильников";
  if (/посудомо/.test(s)) return "Ремонт посудомоечных машин";
  if (/вытяжк/.test(s)) return "Установка/ремонт вытяжек";
  if (/кондицион/.test(s)) return "Установка/ремонт кондиционеров";
  if (/свар|ворот|калитк|забор|навес|перил|лестниц/.test(s)) return "Сварка";
  if (/металлоконструкц/.test(s)) return "Металлоконструкции";
  if (/электр|розетк|люстр|провод|выключател/.test(s)) return "Электрика";
  if (/клининг|уборк/.test(s)) return "Клининг";
  if (/мебел|шкаф|кухн|стеллаж|комод|кроват|гардероб|тумб|витрин/.test(s)) return "Мебель на заказ";
  if (/техник/.test(s)) return "Без кв.";
  return canonService(service);
}
function extractField(rawText, fieldName) {
  const m = rawText?.match(new RegExp(`${fieldName}\\s*:\\s*([^\\n]+)`, "i"));
  return m ? m[1].trim() : "";
}

async function buildDailyReport(targetAlmatyDate) {
  const dateFilter = `
    AND date AT TIME ZONE 'Asia/Almaty' >= $2::date
    AND date AT TIME ZONE 'Asia/Almaty' < ($2::date + INTERVAL '1 day')
  `;

  const leadsR = await pool.query(
    `SELECT raw FROM leads WHERE bot=$1 AND type='lead' ${dateFilter}`, [BOT_NAME, targetAlmatyDate]
  );
  const callbackR = await pool.query(
    `SELECT raw FROM leads WHERE bot=$1 AND type='callback' ${dateFilter}`, [BOT_NAME, targetAlmatyDate]
  );
  const compR = await pool.query(
    `SELECT raw, phone FROM complaints WHERE bot=$1 ${dateFilter}`, [BOT_NAME, targetAlmatyDate]
  );

  const totalDialogs = await getDayDialogCount(targetAlmatyDate);
  const leadsCount    = leadsR.rows.length;
  const callbackCount = callbackR.rows.length;
  const oformleno     = leadsCount + callbackCount;
  const zhaloby       = compR.rows.length;
  const nekonvert     = Math.max(0, totalDialogs - oformleno - zhaloby);
  const konversiya    = totalDialogs > 0 ? Math.round((oformleno / totalDialogs) * 100) : 0;

  const cityServiceMap = {};
  for (const row of leadsR.rows) {
    const city    = normCity(extractField(row.raw, "Город"));
    const service = normService(extractField(row.raw, "Услуга"));
    if (!cityServiceMap[city]) cityServiceMap[city] = {};
    cityServiceMap[city][service] = (cityServiceMap[city][service] || 0) + 1;
  }

  const callbackCityMap = {};
  for (const row of callbackR.rows) {
    const city = normCity(extractField(row.raw, "Город"));
    callbackCityMap[city] = (callbackCityMap[city] || 0) + 1;
  }

  const dateLabel = targetAlmatyDate.split("-").reverse().join(".");
  let report = `📊 СТАТИСТИКА ЗА СУТКИ — ${SHOP_NAME}\n`;
  report += `📅 ${dateLabel}\n\n`;
  report += `💬 Всего диалогов: ${totalDialogs}\n`;
  report += `✅ Оформлено: ${oformleno} (заявок: ${leadsCount}, звонков: ${callbackCount})\n`;
  report += `📈 Конверсия: ${konversiya}%\n`;
  report += `🚨 Жалоб: ${zhaloby}\n`;
  report += `❌ Не конвертировано: ${nekonvert}\n`;

  if (Object.keys(cityServiceMap).length > 0) {
    report += `\n— ЗАЯВКИ ПО ГОРОДАМ —\n`;
    const cities = Object.entries(cityServiceMap)
      .map(([city, svc]) => ({ city, total: Object.values(svc).reduce((a, b) => a + b, 0), svc }))
      .sort((a, b) => b.total - a.total);
    for (const c of cities) {
      report += `\n${c.city} — ${c.total}\n`;
      for (const [svc, count] of Object.entries(c.svc).sort((a, b) => b[1] - a[1])) {
        report += `  ${svc} — ${count}\n`;
      }
    }
  } else {
    report += `\nЗаявок за сутки не было.\n`;
  }

  if (Object.keys(callbackCityMap).length > 0) {
    report += `\n— ЗАПРОСЫ НА ЗВОНОК —\n`;
    for (const [city, count] of Object.entries(callbackCityMap).sort((a, b) => b[1] - a[1])) {
      report += `${city}: ${count}\n`;
    }
  }

  if (compR.rows.length > 0) {
    report += `\n— ЖАЛОБЫ — ${compR.rows.length}\n`;
    for (const row of compR.rows) {
      let tezis = extractField(row.raw, "Тезис");
      if (!tezis) {
        const suть = extractField(row.raw, "Суть") || (row.raw || "").split("\n")[0] || "—";
        tezis = suть.split(" ").slice(0, 10).join(" ");
      }
      report += `  ${row.phone} — ${tezis}\n`;
    }
  }

  return report;
}

async function sendDailyReport(targetAlmatyDate) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT) return;
  const report = await buildDailyReport(targetAlmatyDate);
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: TG_CHAT, text: report });
    console.log(`📊 Отчёт за ${targetAlmatyDate} отправлен`);
  } catch (e) { console.error("Report send error:", e.message); }
}

let lastReportDate = null;
setInterval(() => {
  const { h, m } = getAlmatyHM();
  const today = getAlmatyDate();
  if (h === 23 && m === 59 && lastReportDate !== today) {
    lastReportDate = today;
    sendDailyReport(today);
  }
}, 60 * 1000);

// ── Веб-панели ───────────────────────────────────────────────
app.get("/admin", async (req, res) => {
  const knowledge = await loadKnowledge();
  res.send(adminPage(knowledge));
});

app.post("/admin/save", async (req, res) => {
  if (req.body.password !== (process.env.ADMIN_PASSWORD || "hubmaster")) {
    return res.send("Неверный пароль. <a href='/admin'>Назад</a>");
  }
  await saveKnowledge(req.body.knowledge || "");
  res.send("✅ База знаний обновлена! <a href='/admin'>Назад</a>");
});

app.get("/leads", async (req, res) => {
  const r = await pool.query("SELECT * FROM leads WHERE bot=$1 ORDER BY date DESC LIMIT 200", [BOT_NAME]);
  res.json(r.rows);
});

app.get("/paused", async (req, res) => {
  const list = await getPausedList();
  const pass = req.query.password || "";
  const rows = list.map(n => `
    <tr>
      <td>${n}</td>
      <td><a href="/paused/resume/${n}?password=${encodeURIComponent(pass)}">▶ Вернуть бота</a></td>
    </tr>`).join("");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Паузы</title>
    <style>body{font-family:Arial;padding:20px}table{border-collapse:collapse;width:100%}
    td,th{padding:8px;border:1px solid #ddd}input,button{padding:8px;margin:4px}</style></head>
    <body><h1>⏸ Управление чатами — OKNA PLAST (Юрий)</h1>
    <form method="POST" action="/paused/add">
      <input name="phone" placeholder="номер клиента" required>
      <input type="password" name="password" placeholder="пароль" required>
      <button>Поставить на паузу</button>
    </form>
    <h2>На паузе:</h2>
    ${list.length === 0 ? "<p>Нет</p>" : `<table><tr><th>Номер</th><th>Действие</th></tr>${rows}</table>`}
    </body></html>`);
});

app.post("/paused/add", async (req, res) => {
  if (req.body.password !== (process.env.ADMIN_PASSWORD || "hubmaster")) {
    return res.send("Неверный пароль.");
  }
  const phone = (req.body.phone || "").replace(/[^\d]/g, "");
  if (phone) await setPaused(phone);
  res.redirect("/paused");
});

app.get("/paused/resume/:phone", async (req, res) => {
  if (req.query.password !== (process.env.ADMIN_PASSWORD || "hubmaster")) {
    return res.send("Неверный пароль.");
  }
  await setUnpaused(req.params.phone);
  res.redirect("/paused");
});

app.get("/report/today", async (req, res) => {
  if (req.query.password !== (process.env.ADMIN_PASSWORD || "hubmaster")) return res.send("Неверный пароль");
  const report = await buildDailyReport(getAlmatyDate());
  res.type("text/plain; charset=utf-8").send(report);
});

app.get("/report/send-now", async (req, res) => {
  if (req.query.password !== (process.env.ADMIN_PASSWORD || "hubmaster")) return res.send("Неверный пароль");
  const today = getAlmatyDate();
  await sendDailyReport(today);
  res.send(`Отчёт за ${today} отправлен.`);
});

// ── Регистрация webhook в Wazzup ─────────────────────────────
async function registerWazzupWebhook() {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("⚠️ WEBHOOK_URL не задан — webhook не зарегистрирован");
    return;
  }
  try {
    await axios.patch(
      `${WAZZUP_API_URL}/webhooks`,
      {
        webhooksUri: webhookUrl,
        subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: true },
      },
      { headers: { "Authorization": `Bearer ${WAZZUP_API_KEY}`, "Content-Type": "application/json" } }
    );
    console.log(`✅ Wazzup webhook зарегистрирован: ${webhookUrl}`);
  } catch (err) {
    console.error("Wazzup webhook reg error:", err.response?.data || err.message);
  }
}

// ── Старт ────────────────────────────────────────────────────
initDB().then(async () => {
  app.listen(PORT, () => {
    console.log(`🚀 OKNA PLAST (Юрий / Wazzup) бот запущен на порту ${PORT}`);
  });
  // ВНИМАНИЕ: вебхук Wazzup один на весь аккаунт и зарегистрирован на Нурике.
  // Юрий НЕ регистрирует свой вебхук, иначе перебьёт адрес Нурика.
  // Сообщения своего канала Юрий получает пересылкой от Нурика.
  // await registerWazzupWebhook();
}).catch(err => {
  console.error("❌ Ошибка инициализации БД:", err.message);
  process.exit(1);
});

function adminPage(knowledge) {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OKNA PLAST — Обучение бота</title>
<style>
  body{font-family:-apple-system,Arial;background:#0F2744;color:#fff;margin:0;padding:20px}
  .card{max-width:800px;margin:0 auto;background:#fff;color:#000;border-radius:16px;padding:24px}
  h1{color:#1A8FE3}
  textarea{width:100%;height:380px;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:14px;font-family:monospace;box-sizing:border-box}
  input[type=password]{padding:10px;border:1px solid #ccc;border-radius:8px;width:200px}
  button{background:#1A8FE3;color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:12px}
  label{font-weight:bold;display:block;margin-top:16px}
</style></head>
<body><div class="card">
  <h1>🤖 Обучение бота OKNA PLAST (Юрий)</h1>
  <form method="POST" action="/admin/save">
    <label>База знаний:</label>
    <textarea name="knowledge">${knowledge.replace(/</g, "&lt;")}</textarea>
    <label>Пароль:</label>
    <input type="password" name="password" placeholder="введите пароль">
    <br><button type="submit">Сохранить</button>
  </form>
</div></body></html>`;
}
const BOOT_TIME = new Date().toISOString();

// ── /version — что реально задеплоено (сверка прода с репой) ──
app.get("/version", (req, res) => {
  let greetingBrand = "—";
  try {
    const sys = buildSystemPrompt(null, "");
    let m = sys.match(/консультант\s+(?:компании\s+)?([^\n😊]+?)\s*😊/);
    if (!m) m = sys.match(/консультант компании ([^\n]+?) в Казахстане/);
    greetingBrand = m ? m[1].trim() : "—";
  } catch (e) { greetingBrand = "buildSystemPrompt N/A"; }
  res.json({
    bot: BOT_NAME,
    shop: SHOP_NAME,
    source: SOURCE_NUMBER,
    greetingBrand,
    gitRepo:   process.env.RAILWAY_GIT_REPO_NAME   || "—",
    gitBranch: process.env.RAILWAY_GIT_BRANCH      || "—",
    gitCommit: (process.env.RAILWAY_GIT_COMMIT_SHA || "—").slice(0, 8),
    bootedAt:  BOOT_TIME,
  });
});
