const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL ulanish
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// TELEGRAM SOZLAMALARI
const TELEGRAM_TOKEN = '8622292874:AAFkVwW26nosYBQgBhLv34xlHTzHZl4IPVM';
const TELEGRAM_ADMIN_ID = '6639737082';

// Jadvallarni yaratish
async function initTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                floor INTEGER DEFAULT 0,
                capacity INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS teachers (
                id SERIAL PRIMARY KEY,
                full_name TEXT NOT NULL,
                phone TEXT,
                telegram_id TEXT
            );
            CREATE TABLE IF NOT EXISTS schedule (
                id SERIAL PRIMARY KEY,
                room_id INTEGER,
                teacher_id INTEGER,
                day_of_week INTEGER,
                start_time TEXT,
                end_time TEXT,
                week_start_date TEXT
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                schedule_id INTEGER,
                sent_date TEXT,
                status TEXT
            );
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT
            );
        `);
        
        const adminCheck = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (adminCheck.rows.length === 0) {
            await pool.query("INSERT INTO users (username, password, role) VALUES ('admin', 'admin123', 'admin')");
            await pool.query("INSERT INTO users (username, password, role) VALUES ('display', 'display123', 'display')");
            console.log('✅ Default foydalanuvchilar yaratildi');
        }
        
        console.log('✅ PostgreSQL baza tayyor');
    } catch(e) {
        console.error('Baza xatolik:', e.message);
    }
}

initTables();

// ============ TELEGRAM FUNKSIYALARI ============
async function sendTelegramMessage(chatId, message) {
    if (!TELEGRAM_TOKEN) return false;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
        });
        return response.ok;
    } catch(e) {
        return false;
    }
}

function getDayName(dayOfWeek) {
    const days = { 1: 'Dushanba', 2: 'Seshanba', 3: 'Chorshanba', 4: 'Payshanba', 5: 'Juma', 6: 'Shanba', 7: 'Yakshanba' };
    return days[dayOfWeek];
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toISOString().split('T')[0];
}

// Avtomatik xabar
async function sendDailyNotifications() {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    const todayStr = today.toISOString().split('T')[0];
    
    const schedules = await pool.query(`
        SELECT s.*, t.full_name, t.phone, t.telegram_id, r.name as room_name
        FROM schedule s
        JOIN teachers t ON s.teacher_id = t.id
        JOIN rooms r ON s.room_id = r.id
        WHERE s.day_of_week = $1 AND s.week_start_date = $2
    `, [dayOfWeek, weekStart]);
    
    if (schedules.rows.length === 0) return;
    
    for (const s of schedules.rows) {
        const existing = await pool.query("SELECT * FROM notifications WHERE schedule_id = $1 AND sent_date = $2", [s.id, todayStr]);
        if (existing.rows.length > 0) continue;
        
        const message = `🏥 SIMULYATSION MARKAZI\n\n❗ NAVATCHILIK HAQIDA ESLATMA\n\n👨‍🏫 Hurmatli ${s.full_name}!\n\n📅 Bugun: ${getDayName(dayOfWeek)}\n⏰ Vaqt: ${s.start_time} - ${s.end_time}\n🚪 Xona: ${s.room_name}\n\n⚠️ Vaqtida kelishingizni so'raymiz!\n\n© TDTU Simulyatsion markazi`;
        
        let sent = false;
        if (s.telegram_id && s.telegram_id.length > 3) {
            sent = await sendTelegramMessage(s.telegram_id, message);
        }
        if (!sent) console.log(`📱 [TEST] ${s.full_name}`);
        
        await pool.query("INSERT INTO notifications (schedule_id, sent_date, status) VALUES ($1, $2, $3)", [s.id, todayStr, sent ? 'sent' : 'failed']);
    }
}

cron.schedule('30 6 * * *', () => {
    console.log('⏰ Avtomatik xabar yuborish boshlandi (6:30)...');
    sendDailyNotifications();
});

// Polling
let lastUpdateId = 0;

async function pollTelegramUpdates() {
    if (!TELEGRAM_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=30&offset=${lastUpdateId + 1}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.ok && data.result) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                const message = update.message;
                if (message) {
                    const chatId = message.chat.id;
                    const firstName = message.chat.first_name || '';
                    const lastName = message.chat.last_name || '';
                    const fullName = `${firstName} ${lastName}`.trim();
                    
                    await sendTelegramMessage(chatId, 
                        `✅ Siz muvaffaqiyatli ro'yxatdan o'tdingiz!\n\n👤 Ismingiz: ${fullName}\n🆔 Telegram ID: <code>${chatId}</code>\n\n📝 Admin panelga qo'shish: O'qituvchilar → Tahrirlash → Telegram ID: ${chatId}`
                    );
                    await sendTelegramMessage(TELEGRAM_ADMIN_ID, 
                        `🆕 YANGI O'QITUVCHI!\n👤 Ism: ${fullName}\n🆔 Telegram ID: <code>${chatId}</code>`
                    );
                }
            }
        }
    } catch(e) {}
    setTimeout(pollTelegramUpdates, 1000);
}

setTimeout(() => {
    if (TELEGRAM_TOKEN) {
        console.log('🤖 Telegram bot polling boshlandi...');
        pollTelegramUpdates();
    }
}, 2000);

// ============ ASOSIY YO'NALISH (ROOT) ============
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

// ============ API ============
app.post('/api/login', async (req, res) => {
    const { username, password, role } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1 AND password = $2 AND role = $3", [username, password, role]);
    if (result.rows.length > 0) res.json({ success: true });
    else res.json({ success: false });
});

app.get('/api/rooms', async (req, res) => {
    const result = await pool.query("SELECT * FROM rooms ORDER BY id");
    res.json(result.rows);
});

app.post('/api/rooms', async (req, res) => {
    const { name } = req.body;
    const result = await pool.query("INSERT INTO rooms (name) VALUES ($1) RETURNING id", [name]);
    res.json({ id: result.rows[0].id });
});

app.put('/api/rooms/:id', async (req, res) => {
    const { name } = req.body;
    await pool.query("UPDATE rooms SET name = $1 WHERE id = $2", [name, req.params.id]);
    res.json({ updated: true });
});

app.delete('/api/rooms/:id', async (req, res) => {
    await pool.query("DELETE FROM rooms WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
});

app.get('/api/teachers', async (req, res) => {
    const result = await pool.query("SELECT * FROM teachers ORDER BY id");
    res.json(result.rows);
});

app.post('/api/teachers', async (req, res) => {
    const { full_name, phone, telegram_id } = req.body;
    const result = await pool.query("INSERT INTO teachers (full_name, phone, telegram_id) VALUES ($1, $2, $3) RETURNING id", [full_name, phone, telegram_id || '']);
    res.json({ id: result.rows[0].id });
});

app.put('/api/teachers/:id', async (req, res) => {
    const { full_name, phone, telegram_id } = req.body;
    await pool.query("UPDATE teachers SET full_name = $1, phone = $2, telegram_id = $3 WHERE id = $4", [full_name, phone, telegram_id, req.params.id]);
    res.json({ updated: true });
});

app.delete('/api/teachers/:id', async (req, res) => {
    await pool.query("DELETE FROM teachers WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
});

app.get('/api/schedule', async (req, res) => {
    const { week_start } = req.query;
    let query = `SELECT s.*, r.name as room_name, t.full_name as teacher_name, t.phone, t.telegram_id,
                        n.status as notification_status
                 FROM schedule s
                 LEFT JOIN rooms r ON s.room_id = r.id
                 LEFT JOIN teachers t ON s.teacher_id = t.id
                 LEFT JOIN notifications n ON n.schedule_id = s.id AND n.sent_date = CURRENT_DATE`;
    if (week_start && week_start !== 'undefined') query += ` WHERE s.week_start_date = '${week_start}'`;
    query += ` ORDER BY s.day_of_week, s.start_time`;
    const result = await pool.query(query);
    res.json(result.rows);
});

app.post('/api/schedule', async (req, res) => {
    const { room_id, teacher_id, day_of_week, start_time, end_time, week_start_date } = req.body;
    const result = await pool.query(
        `INSERT INTO schedule (room_id, teacher_id, day_of_week, start_time, end_time, week_start_date) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [room_id, teacher_id, day_of_week, start_time, end_time, week_start_date]
    );
    res.json({ id: result.rows[0].id });
});

app.put('/api/schedule/:id', async (req, res) => {
    const { room_id, teacher_id, day_of_week, start_time, end_time, week_start_date } = req.body;
    await pool.query(
        `UPDATE schedule SET room_id = $1, teacher_id = $2, day_of_week = $3, start_time = $4, end_time = $5, week_start_date = $6 WHERE id = $7`,
        [room_id, teacher_id, day_of_week, start_time, end_time, week_start_date, req.params.id]
    );
    res.json({ updated: true });
});

app.delete('/api/schedule/:id', async (req, res) => {
    await pool.query("DELETE FROM schedule WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
});

app.get('/api/today-schedule', async (req, res) => {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    const result = await pool.query(
        `SELECT s.*, r.name as room_name, t.full_name as teacher_name, t.phone
         FROM schedule s
         LEFT JOIN rooms r ON s.room_id = r.id
         LEFT JOIN teachers t ON s.teacher_id = t.id
         WHERE s.day_of_week = $1 AND s.week_start_date = $2
         ORDER BY s.start_time`,
        [dayOfWeek, weekStart]
    );
    res.json(result.rows);
});

app.post('/api/schedule/copy-week', async (req, res) => {
    const { from_week, to_week } = req.body;
    await pool.query(
        `INSERT INTO schedule (room_id, teacher_id, day_of_week, start_time, end_time, week_start_date)
         SELECT room_id, teacher_id, day_of_week, start_time, end_time, $1 FROM schedule WHERE week_start_date = $2`,
        [to_week, from_week]
    );
    res.json({ copied: true });
});

app.post('/api/send-message', async (req, res) => {
    const { teacherId, message } = req.body;
    const teacher = await pool.query("SELECT * FROM teachers WHERE id = $1", [teacherId]);
    if (teacher.rows.length === 0) return res.json({ success: false });
    
    let sent = false;
    if (teacher.rows[0].telegram_id && teacher.rows[0].telegram_id.length > 3) {
        sent = await sendTelegramMessage(teacher.rows[0].telegram_id, message);
    }
    if (!sent) console.log(`📱 [TEST] ${teacher.rows[0].full_name}`);
    
    const today = new Date().toISOString().split('T')[0];
    await pool.query("INSERT INTO notifications (schedule_id, sent_date, status) VALUES ($1, $2, 'sent')", [teacherId, today]);
    res.json({ success: true });
});

app.post('/api/send-all-messages', async (req, res) => {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    const schedules = await pool.query(
        `SELECT s.teacher_id, t.full_name, t.telegram_id, t.phone, s.start_time, r.name as room_name
         FROM schedule s
         JOIN teachers t ON s.teacher_id = t.id
         JOIN rooms r ON s.room_id = r.id
         WHERE s.day_of_week = $1 AND s.week_start_date = $2`,
        [dayOfWeek, weekStart]
    );
    
    let count = 0;
    for (const s of schedules.rows) {
        const message = `🏥 SIMULYATSION MARKAZI\n\n❗ NAVATCHILIK HAQIDA ESLATMA\n\n👨‍🏫 Hurmatli ${s.full_name}!\n\n📅 Bugun: ${getDayName(dayOfWeek)}\n⏰ Vaqt: ${s.start_time} - ${s.end_time}\n🚪 Xona: ${s.room_name}\n\n⚠️ Vaqtida kelishingizni so'raymiz!\n\n© TDTU Simulyatsion markazi`;
        let sent = false;
        if (s.telegram_id && s.telegram_id.length > 3) {
            sent = await sendTelegramMessage(s.telegram_id, message);
        }
        if (!sent) console.log(`📱 [TEST] ${s.full_name}`);
        count++;
        const todayStr = new Date().toISOString().split('T')[0];
        await pool.query("INSERT INTO notifications (schedule_id, sent_date, status) VALUES ($1, $2, 'sent')", [s.teacher_id, todayStr]);
    }
    res.json({ success: true, count: count, total: schedules.rows.length });
});

app.listen(PORT, () => {
    console.log(`\n🚀 SERVER ISHGA TUSHDI!`);
    console.log(`📡 Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`📺 Katta ekran: http://localhost:${PORT}/display.html`);
    console.log(`\n🔐 Admin: admin / admin123`);
    console.log(`🔐 Display: display / display123`);
    console.log(`\n🤖 Telegram bot: @SimulyatsionMarkaziBot`);
    console.log(`⏰ Avtomatik xabar: har kuni ertalab 6:30\n`);
});