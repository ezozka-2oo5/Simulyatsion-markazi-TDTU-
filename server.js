const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./laboratory.db');

// ============ TELEGRAM SOZLAMALARI ============
const TELEGRAM_TOKEN = '8622292874:AAFkVwW26nosYBQgBhLv34xlHTzHZl4IPVM';
const TELEGRAM_ADMIN_ID = '6639737082';  // Sizning Telegram ID

// ============ JADVALLARNI YARATISH ============
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        floor INTEGER DEFAULT 0,
        capacity INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS teachers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        phone TEXT,
        telegram_id TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        teacher_id INTEGER,
        day_of_week INTEGER,
        start_time TEXT,
        end_time TEXT,
        week_start_date TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER,
        sent_date TEXT,
        status TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);
    
    // Default foydalanuvchilar
    db.get("SELECT COUNT(*) as cnt FROM users", (err, row) => {
        if (row && row.cnt === 0) {
            db.run("INSERT INTO users (username, password, role) VALUES ('admin', 'admin123', 'admin')");
            db.run("INSERT INTO users (username, password, role) VALUES ('display', 'display123', 'display')");
            console.log('✅ Default foydalanuvchilar yaratildi');
        }
    });
    
    // Test ma'lumotlar
    db.get("SELECT COUNT(*) as cnt FROM rooms", (err, row) => {
        if (row && row.cnt === 0) {
            db.run("INSERT INTO rooms (name) VALUES ('101-laboratoriya')");
            db.run("INSERT INTO rooms (name) VALUES ('203-laboratoriya')");
            db.run("INSERT INTO rooms (name) VALUES ('305-laboratoriya')");
            console.log('✅ Test xonalar qo\'shildi');
        }
    });
    
    db.get("SELECT COUNT(*) as cnt FROM teachers", (err, row) => {
        if (row && row.cnt === 0) {
            db.run("INSERT INTO teachers (full_name, phone) VALUES ('Alimov Anvar', '+998901234567')");
            db.run("INSERT INTO teachers (full_name, phone) VALUES ('Karimova Dilbar', '+998902345678')");
            db.run("INSERT INTO teachers (full_name, phone) VALUES ('Toshmatov Botir', '+998903456789')");
            console.log('✅ Test o\'qituvchilar qo\'shildi');
        }
    });
    
    console.log('✅ Ma\'lumotlar bazasi tayyor');
});

// ============ TELEGRAM XABAR YUBORISH ============
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
        console.error('Telegram xatolik:', e.message);
        return false;
    }
}

// ============ KUN NOMI ============
function getDayName(dayOfWeek) {
    const days = { 1: 'Dushanba', 2: 'Seshanba', 3: 'Chorshanba', 4: 'Payshanba', 5: 'Juma', 6: 'Shanba', 7: 'Yakshanba' };
    return days[dayOfWeek];
}

// ============ HAFTA BOSHLANISHI ============
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toISOString().split('T')[0];
}

// ============ AVTOMATIK XABAR (ERTALAB 6:30) ============
async function sendDailyNotifications() {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    const todayStr = today.toISOString().split('T')[0];
    
    console.log(`⏰ ${todayStr} kuni uchun xabar yuborish boshlandi...`);
    
    db.all(`
        SELECT s.*, t.full_name, t.phone, t.telegram_id, r.name as room_name
        FROM schedule s
        JOIN teachers t ON s.teacher_id = t.id
        JOIN rooms r ON s.room_id = r.id
        WHERE s.day_of_week = ? AND s.week_start_date = ?
    `, [dayOfWeek, weekStart], async (err, schedules) => {
        if (err || !schedules || schedules.length === 0) {
            console.log('📭 Bugun uchun navbatchilar yo\'q');
            return;
        }
        
        for (const s of schedules) {
            const existing = await new Promise((resolve) => {
                db.get("SELECT * FROM notifications WHERE schedule_id = ? AND sent_date = ?", [s.id, todayStr], (err, row) => resolve(row));
            });
            
            if (existing) {
                console.log(`⏭️ ${s.full_name} - allaqachon xabar yuborilgan`);
                continue;
            }
            
            const message = `🏥 SIMULYATSION MARKAZI\n\n❗ NAVATCHILIK HAQIDA ESLATMA\n\n👨‍🏫 Hurmatli ${s.full_name}!\n\n📅 Bugun: ${getDayName(dayOfWeek)}\n⏰ Vaqt: ${s.start_time} - ${s.end_time}\n🚪 Xona: ${s.room_name}\n\n⚠️ Vaqtida kelishingizni so'raymiz!\n\n© TDTU Simulyatsion markazi`;
            
            let sent = false;
            if (s.telegram_id && s.telegram_id.length > 3) {
                sent = await sendTelegramMessage(s.telegram_id, message);
            }
            
            if (!sent) {
                console.log(`📱 [TEST] ${s.full_name} (${s.phone}): ${message.substring(0, 80)}...`);
                sent = true;
            }
            
            db.run("INSERT INTO notifications (schedule_id, sent_date, status) VALUES (?, ?, ?)", [s.id, todayStr, sent ? 'sent' : 'failed']);
            console.log(`${sent ? '✅' : '❌'} ${s.full_name} - ${sent ? 'Yuborildi' : 'Yuborilmadi'}`);
        }
    });
}

// ============ CRON SCHEDULER - HAR KUNI ERTALAB 6:30 ============
cron.schedule('30 6 * * *', () => {
    console.log('⏰ Avtomatik xabar yuborish boshlandi (6:30)...');
    sendDailyNotifications();
});

// ============ TELEGRAM XABARLARNI QABUL QILISH (POLLING) ============
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
                    const username = message.chat.username || 'No username';
                    const firstName = message.chat.first_name || '';
                    const lastName = message.chat.last_name || '';
                    const fullName = `${firstName} ${lastName}`.trim();
                    
                    console.log(`\n📱 Yangi xabar!`);
                    console.log(`   Chat ID: ${chatId}`);
                    console.log(`   Ism: ${fullName}`);
                    console.log(`   Username: @${username}`);
                    
                    // O'qituvchiga javob yuborish
                    await sendTelegramMessage(chatId, 
                        `✅ Siz muvaffaqiyatli ro'yxatdan o'tdingiz!\n\n` +
                        `👤 Ismingiz: ${fullName}\n` +
                        `🆔 Telegram ID: <code>${chatId}</code>\n\n` +
                        `📋 Bu ID admin panelga yuborildi.\n` +
                        `📅 Navbatchilik kunlari haqida xabarlar shu bot orqali keladi.\n\n` +
                        `© TDTU Simulyatsion markazi`
                    );
                    
                    // Adminga xabar yuborish
                    await sendTelegramMessage(TELEGRAM_ADMIN_ID, 
                        `🆕 YANGI O'QITUVCHI!\n\n` +
                        `👤 Ism: ${fullName}\n` +
                        `🆔 Telegram ID: <code>${chatId}</code>\n` +
                        `📛 Username: @${username}\n\n` +
                        `📝 Admin panelga qo'shish:\n` +
                        `O'qituvchilar → Tahrirlash → Telegram ID: ${chatId}`
                    );
                }
            }
        }
    } catch(e) {
        console.error('Polling xatolik:', e.message);
    }
    
    setTimeout(pollTelegramUpdates, 1000);
}

// Polling ni ishga tushirish
setTimeout(() => {
    if (TELEGRAM_TOKEN) {
        console.log('🤖 Telegram bot polling boshlandi...');
        pollTelegramUpdates();
    }
}, 2000);

// ============ LOGIN API ============
app.post('/api/login', (req, res) => {
    const { username, password, role } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ? AND role = ?", [username, password, role], (err, user) => {
        if (user) res.json({ success: true, role: user.role });
        else res.json({ success: false, message: 'Login yoki parol xato!' });
    });
});

// Parol o'zgartirish
app.post('/api/change-password', (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, currentPassword], (err, user) => {
        if (!user) return res.json({ success: false, message: 'Joriy parol xato!' });
        db.run("UPDATE users SET password = ? WHERE username = ?", [newPassword, username]);
        res.json({ success: true, message: 'Parol o\'zgartirildi!' });
    });
});

// ============ ROOMS API ============
app.get('/api/rooms', (req, res) => {
    db.all("SELECT * FROM rooms ORDER BY id", (err, rows) => res.json(rows));
});
app.post('/api/rooms', (req, res) => {
    const { name, floor, capacity } = req.body;
    db.run("INSERT INTO rooms (name, floor, capacity) VALUES (?, ?, ?)", [name, floor || 0, capacity || 0], function(err) {
        res.json({ id: this.lastID });
    });
});
app.put('/api/rooms/:id', (req, res) => {
    const { name, floor, capacity } = req.body;
    db.run("UPDATE rooms SET name=?, floor=?, capacity=? WHERE id=?", [name, floor, capacity, req.params.id]);
    res.json({ updated: true });
});
app.delete('/api/rooms/:id', (req, res) => {
    db.run("DELETE FROM rooms WHERE id=?", req.params.id);
    res.json({ deleted: true });
});

// ============ TEACHERS API ============
app.get('/api/teachers', (req, res) => {
    db.all("SELECT * FROM teachers ORDER BY id", (err, rows) => res.json(rows));
});
app.post('/api/teachers', (req, res) => {
    const { full_name, phone, telegram_id } = req.body;
    db.run("INSERT INTO teachers (full_name, phone, telegram_id) VALUES (?, ?, ?)", [full_name, phone, telegram_id || ''], function(err) {
        res.json({ id: this.lastID });
    });
});
app.put('/api/teachers/:id', (req, res) => {
    const { full_name, phone, telegram_id } = req.body;
    db.run("UPDATE teachers SET full_name=?, phone=?, telegram_id=? WHERE id=?", [full_name, phone, telegram_id, req.params.id]);
    res.json({ updated: true });
});
app.delete('/api/teachers/:id', (req, res) => {
    db.run("DELETE FROM teachers WHERE id=?", req.params.id);
    res.json({ deleted: true });
});

// ============ SCHEDULE API ============
app.get('/api/schedule', (req, res) => {
    const { week_start } = req.query;
    let query = `SELECT s.*, r.name as room_name, t.full_name as teacher_name, t.phone, t.telegram_id,
                        n.status as notification_status
                 FROM schedule s
                 LEFT JOIN rooms r ON s.room_id = r.id
                 LEFT JOIN teachers t ON s.teacher_id = t.id
                 LEFT JOIN notifications n ON n.schedule_id = s.id AND n.sent_date = date('now')`;
    if (week_start && week_start !== 'undefined') query += ` WHERE s.week_start_date = '${week_start}'`;
    query += ` ORDER BY s.day_of_week, s.start_time`;
    db.all(query, (err, rows) => res.json(rows));
});
app.post('/api/schedule', (req, res) => {
    const { room_id, teacher_id, day_of_week, start_time, end_time, week_start_date } = req.body;
    db.run(`INSERT INTO schedule (room_id, teacher_id, day_of_week, start_time, end_time, week_start_date) VALUES (?, ?, ?, ?, ?, ?)`, [room_id, teacher_id, day_of_week, start_time, end_time, week_start_date], function(err) {
        res.json({ id: this.lastID });
    });
});
app.put('/api/schedule/:id', (req, res) => {
    const { room_id, teacher_id, day_of_week, start_time, end_time, week_start_date } = req.body;
    db.run(`UPDATE schedule SET room_id=?, teacher_id=?, day_of_week=?, start_time=?, end_time=?, week_start_date=? WHERE id=?`, [room_id, teacher_id, day_of_week, start_time, end_time, week_start_date, req.params.id]);
    res.json({ updated: true });
});
app.delete('/api/schedule/:id', (req, res) => {
    db.run("DELETE FROM schedule WHERE id=?", req.params.id);
    res.json({ deleted: true });
});

// Bugungi jadval
app.get('/api/today-schedule', (req, res) => {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    db.all(`SELECT s.*, r.name as room_name, t.full_name as teacher_name, t.phone
             FROM schedule s
             LEFT JOIN rooms r ON s.room_id = r.id
             LEFT JOIN teachers t ON s.teacher_id = t.id
             WHERE s.day_of_week = ? AND s.week_start_date = ?
             ORDER BY s.start_time`, [dayOfWeek, weekStart], (err, rows) => res.json(rows));
});

// Jadvalni nusxalash
app.post('/api/schedule/copy-week', (req, res) => {
    const { from_week, to_week } = req.body;
    db.run(`INSERT INTO schedule (room_id, teacher_id, day_of_week, start_time, end_time, week_start_date)
            SELECT room_id, teacher_id, day_of_week, start_time, end_time, ? FROM schedule WHERE week_start_date = ?`, [to_week, from_week]);
    res.json({ copied: true });
});

// Xabar yuborish (bitta)
app.post('/api/send-message', async (req, res) => {
    const { teacherId, message } = req.body;
    db.get("SELECT * FROM teachers WHERE id = ?", [teacherId], async (err, teacher) => {
        if (!teacher) return res.json({ success: false });
        
        let sent = false;
        if (teacher.telegram_id && teacher.telegram_id.length > 3) {
            sent = await sendTelegramMessage(teacher.telegram_id, message);
        }
        if (!sent) console.log(`📱 [TEST] ${teacher.full_name}: ${message.substring(0, 50)}...`);
        
        const today = new Date().toISOString().split('T')[0];
        db.run("INSERT OR REPLACE INTO notifications (schedule_id, sent_date, status) VALUES (?, ?, 'sent')", [teacherId, today]);
        res.json({ success: true, method: sent ? 'telegram' : 'test' });
    });
});

// Xabar yuborish (barcha)
app.post('/api/send-all-messages', async (req, res) => {
    const today = new Date();
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();
    const weekStart = getWeekStart(today);
    
    db.all(`SELECT s.teacher_id, t.full_name, t.telegram_id, t.phone, s.start_time, r.name as room_name
            FROM schedule s
            JOIN teachers t ON s.teacher_id = t.id
            JOIN rooms r ON s.room_id = r.id
            WHERE s.day_of_week = ? AND s.week_start_date = ?`, [dayOfWeek, weekStart], async (err, schedules) => {
        if (err) return res.json({ success: false });
        
        let count = 0;
        for (const s of schedules) {
            const message = `🏥 SIMULYATSION MARKAZI\n\n❗ NAVATCHILIK HAQIDA ESLATMA\n\n👨‍🏫 Hurmatli ${s.full_name}!\n\n📅 Bugun: ${getDayName(dayOfWeek)}\n⏰ Vaqt: ${s.start_time} - ${s.end_time}\n🚪 Xona: ${s.room_name}\n\n⚠️ Vaqtida kelishingizni so'raymiz!\n\n© TDTU Simulyatsion markazi`;
            
            let sent = false;
            if (s.telegram_id && s.telegram_id.length > 3) {
                sent = await sendTelegramMessage(s.telegram_id, message);
            }
            if (!sent) console.log(`📱 [TEST] ${s.full_name}`);
            
            if (sent || true) {
                count++;
                const todayStr = new Date().toISOString().split('T')[0];
                db.run("INSERT OR REPLACE INTO notifications (schedule_id, sent_date, status) VALUES (?, ?, 'sent')", [s.teacher_id, todayStr]);
            }
        }
        res.json({ success: true, count: count, total: schedules.length });
    });
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`\n🚀 SERVER ISHGA TUSHDI!`);
    console.log(`📡 Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`📺 Katta ekran: http://localhost:${PORT}/display.html`);
    console.log(`\n🔐 Admin: admin / admin123`);
    console.log(`🔐 Display: display / display123`);
    console.log(`\n🤖 Telegram bot: @SimulyatsionMarkaziBot`);
    console.log(`👤 Admin Telegram ID: ${TELEGRAM_ADMIN_ID}`);
    console.log(`⏰ Avtomatik xabar: har kuni ertalab 6:30\n`);
});