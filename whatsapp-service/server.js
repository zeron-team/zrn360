/**
 * Zeron CRM — WhatsApp Web Integration Microservice
 * Uses whatsapp-web.js to connect to WhatsApp Web via QR code.
 * Provides REST API + WebSocket for the CRM frontend.
 * Stores conversations and messages in PostgreSQL.
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ─── PostgreSQL ───
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'zeron_crm',
    user: 'zeron_user',
    password: 'zeron_password',
});

// ─── Database init ───
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS wa_conversations (
                id SERIAL PRIMARY KEY,
                chat_id VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(255),
                phone VARCHAR(50),
                is_group BOOLEAN DEFAULT false,
                profile_pic_url TEXT,
                last_message TEXT,
                last_message_at TIMESTAMPTZ,
                unread_count INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS wa_messages (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER REFERENCES wa_conversations(id) ON DELETE CASCADE,
                chat_id VARCHAR(100) NOT NULL,
                wa_message_id VARCHAR(200),
                from_me BOOLEAN DEFAULT false,
                sender_name VARCHAR(255),
                body TEXT,
                media_type VARCHAR(50),
                media_url TEXT,
                timestamp TIMESTAMPTZ NOT NULL,
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_id ON wa_messages(chat_id);
            CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON wa_messages(timestamp);
            CREATE INDEX IF NOT EXISTS idx_wa_conversations_last_msg ON wa_conversations(last_message_at DESC NULLS LAST);
        `);
        console.log('✅ Database tables ready');
    } finally {
        client.release();
    }
}

// ─── WhatsApp Client ───
let waClient = null;
let currentQR = null;
let clientStatus = 'disconnected'; // disconnected, qr_pending, ready, auth_failure

function broadcastWS(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(msg);
    });
}

function createWAClient() {
    if (waClient) {
        try { waClient.destroy(); } catch (e) { }
    }

    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: '/home/ubuntu/zrn-crm/whatsapp-service/.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--single-process',
                '--disable-extensions',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--js-flags=--max-old-space-size=256',
            ],
        },
    });

    waClient.on('qr', async (qr) => {
        console.log('📱 QR code received');
        currentQR = qr;
        clientStatus = 'qr_pending';
        try {
            const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
            broadcastWS({ type: 'qr', qr: qrDataUrl });
        } catch (e) {
            console.error('QR generation error:', e);
        }
    });

    waClient.on('ready', async () => {
        console.log('✅ WhatsApp client ready');
        currentQR = null;
        clientStatus = 'ready';
        broadcastWS({ type: 'status', status: 'ready' });
        // Sync existing chats
        syncChats();
    });

    waClient.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated');
        clientStatus = 'authenticated';
        broadcastWS({ type: 'status', status: 'authenticated' });
    });

    waClient.on('auth_failure', (msg) => {
        console.error('❌ Auth failure:', msg);
        clientStatus = 'auth_failure';
        currentQR = null;
        broadcastWS({ type: 'status', status: 'auth_failure', message: msg });
    });

    waClient.on('disconnected', (reason) => {
        console.log('🔌 Disconnected:', reason);
        clientStatus = 'disconnected';
        currentQR = null;
        broadcastWS({ type: 'status', status: 'disconnected', reason });
    });

    // Incoming messages
    waClient.on('message', async (msg) => {
        try {
            await saveMessage(msg, false);
            const contact = await msg.getContact();
            broadcastWS({
                type: 'message',
                chatId: msg.from,
                message: {
                    id: msg.id._serialized,
                    body: msg.body,
                    fromMe: false,
                    senderName: contact?.pushname || contact?.name || msg.from,
                    timestamp: msg.timestamp * 1000,
                    hasMedia: msg.hasMedia,
                    type: msg.type,
                },
            });
        } catch (e) {
            console.error('Error handling incoming message:', e);
        }
    });

    // Outgoing messages (sent from phone)
    waClient.on('message_create', async (msg) => {
        if (msg.fromMe) {
            try {
                await saveMessage(msg, true);
            } catch (e) {
                console.error('Error saving outgoing message:', e);
            }
        }
    });

    console.log('🚀 Initializing WhatsApp client...');
    waClient.initialize().catch(err => {
        console.error('Failed to initialize WA client:', err);
        clientStatus = 'disconnected';
    });
}

// ─── Save message to DB ───
async function saveMessage(msg, fromMe) {
    const chatId = fromMe ? msg.to : msg.from;
    const senderName = fromMe ? 'Yo' : (msg._data?.notifyName || chatId.replace(/@.*/, ''));

    // Upsert conversation
    await pool.query(`
        INSERT INTO wa_conversations (chat_id, name, phone, is_group, last_message, last_message_at, unread_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (chat_id) DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), wa_conversations.name),
            last_message = EXCLUDED.last_message,
            last_message_at = EXCLUDED.last_message_at,
            unread_count = CASE WHEN $8 THEN wa_conversations.unread_count ELSE wa_conversations.unread_count + 1 END,
            updated_at = NOW()
    `, [
        chatId,
        senderName,
        chatId.replace(/@.*/, ''),
        chatId.includes('@g.us'),
        msg.body?.substring(0, 200) || '',
        new Date(msg.timestamp * 1000),
        fromMe ? 0 : 1,
        fromMe,
    ]);

    // Look up conversation_id
    const convResult = await pool.query('SELECT id FROM wa_conversations WHERE chat_id = $1', [chatId]);
    const conversationId = convResult.rows[0]?.id;
    if (!conversationId) return;

    // Insert message directly (avoid subquery issues)
    await pool.query(`
        INSERT INTO wa_messages (conversation_id, chat_id, wa_message_id, from_me, sender_name, body, media_type, timestamp, is_read)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
    `, [
        conversationId,
        chatId,
        msg.id._serialized,
        fromMe,
        senderName,
        msg.body || '',
        msg.hasMedia ? msg.type : null,
        new Date(msg.timestamp * 1000),
        fromMe,
    ]);
    console.log(`💾 Saved msg ${fromMe ? '→' : '←'} ${chatId.replace(/@.*/, '')} : ${(msg.body || '').substring(0, 40)}`);
}

// ─── Sync existing chats (fast — no profile pics) ───
async function syncChats() {
    if (!waClient || clientStatus !== 'ready') return;
    try {
        const chats = await waClient.getChats();
        const batch = chats.slice(0, 50);
        // Use Promise.allSettled for parallel DB inserts (skip profile pics for speed)
        await Promise.allSettled(batch.map(async (chat) => {
            try {
                await pool.query(`
                    INSERT INTO wa_conversations (chat_id, name, phone, is_group, last_message, last_message_at, unread_count)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (chat_id) DO UPDATE SET
                        name = COALESCE(EXCLUDED.name, wa_conversations.name),
                        last_message = COALESCE(EXCLUDED.last_message, wa_conversations.last_message),
                        last_message_at = COALESCE(EXCLUDED.last_message_at, wa_conversations.last_message_at),
                        unread_count = EXCLUDED.unread_count,
                        updated_at = NOW()
                `, [
                    chat.id._serialized,
                    chat.name || chat.contact?.pushname || chat.id._serialized.replace(/@.*/, ''),
                    chat.id._serialized.replace(/@.*/, ''),
                    chat.isGroup,
                    chat.lastMessage?.body?.substring(0, 200) || null,
                    chat.lastMessage ? new Date(chat.lastMessage.timestamp * 1000) : null,
                    chat.unreadCount || 0,
                ]);
            } catch (e) { /* skip */ }
        }));
        console.log(`✅ Synced ${batch.length} chats (fast)`);
        broadcastWS({ type: 'chats_synced' });
    } catch (e) {
        console.error('Error syncing chats:', e);
    }
}

// ═══════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════

// Status
app.get('/status', (req, res) => {
    res.json({ status: clientStatus, hasQR: !!currentQR });
});

// QR code
app.get('/qr', async (req, res) => {
    if (clientStatus === 'ready') return res.json({ status: 'ready', qr: null });
    if (!currentQR) return res.json({ status: clientStatus, qr: null });
    try {
        const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 300 });
        res.json({ status: 'qr_pending', qr: qrDataUrl });
    } catch (e) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// Initialize / Reconnect
app.post('/connect', (req, res) => {
    if (clientStatus === 'ready') return res.json({ status: 'already_connected' });
    createWAClient();
    res.json({ status: 'initializing' });
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (waClient) {
            await waClient.logout();
            await waClient.destroy();
        }
        waClient = null;
        clientStatus = 'disconnected';
        currentQR = null;
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List conversations from DB
app.get('/chats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM wa_conversations
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT 200
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get messages for a conversation
app.get('/chats/:chatId/messages', async (req, res) => {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    console.log(`📨 GET messages for: ${chatId}`);
    try {
        // First load from DB
        const dbMessages = await pool.query(`
            SELECT * FROM wa_messages
            WHERE chat_id = $1
            ORDER BY timestamp ASC
            LIMIT $2
        `, [chatId, limit]);
        console.log(`   DB has ${dbMessages.rows.length} messages`);

        // If few messages in DB, fetch from WhatsApp SYNCHRONOUSLY
        if (dbMessages.rows.length < 5 && waClient && clientStatus === 'ready') {
            console.log('   Fetching from WhatsApp...');
            try {
                // First ensure conversation exists in DB
                let convResult = await pool.query(
                    'SELECT id FROM wa_conversations WHERE chat_id = $1', [chatId]
                );
                if (convResult.rows.length === 0) {
                    // Create the conversation first
                    console.log('   Creating conversation record...');
                    await pool.query(`
                        INSERT INTO wa_conversations (chat_id, name, phone, is_group)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (chat_id) DO NOTHING
                    `, [chatId, chatId.replace(/@.*/, ''), chatId.replace(/@.*/, ''), chatId.includes('@g.us')]);
                    convResult = await pool.query(
                        'SELECT id FROM wa_conversations WHERE chat_id = $1', [chatId]
                    );
                }
                const conversationId = convResult.rows[0]?.id;
                console.log(`   Conversation ID: ${conversationId}`);

                if (conversationId) {
                    const chat = await waClient.getChatById(chatId);
                    const waMessages = await chat.fetchMessages({ limit: 30 });
                    console.log(`   WhatsApp returned ${waMessages.length} messages`);

                    let inserted = 0;
                    for (const msg of waMessages) {
                        try {
                            const result = await pool.query(`
                                INSERT INTO wa_messages (conversation_id, chat_id, wa_message_id, from_me, sender_name, body, media_type, timestamp, is_read)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                                ON CONFLICT DO NOTHING
                            `, [
                                conversationId,
                                chatId,
                                msg.id._serialized,
                                msg.fromMe,
                                msg.fromMe ? 'Yo' : (msg._data?.notifyName || chatId.replace(/@.*/, '')),
                                msg.body || '',
                                msg.hasMedia ? msg.type : null,
                                new Date(msg.timestamp * 1000),
                                true,
                            ]);
                            if (result.rowCount > 0) inserted++;
                        } catch (insertErr) {
                            console.error('   Insert error:', insertErr.message);
                        }
                    }
                    console.log(`   Inserted ${inserted} new messages`);

                    // Re-fetch from DB after sync
                    const updated = await pool.query(`
                        SELECT * FROM wa_messages WHERE chat_id = $1
                        ORDER BY timestamp ASC LIMIT $2
                    `, [chatId, limit]);
                    console.log(`   Returning ${updated.rows.length} messages after sync`);
                    await pool.query(`UPDATE wa_messages SET is_read = true WHERE chat_id = $1 AND is_read = false`, [chatId]);
                    await pool.query(`UPDATE wa_conversations SET unread_count = 0 WHERE chat_id = $1`, [chatId]);
                    return res.json(updated.rows);
                }
            } catch (fetchErr) {
                console.error('   WA fetch error:', fetchErr.message);
                // Fall through to return whatever we have
            }
        }

        // Mark as read in DB
        await pool.query(`UPDATE wa_messages SET is_read = true WHERE chat_id = $1 AND is_read = false`, [chatId]);
        await pool.query(`UPDATE wa_conversations SET unread_count = 0 WHERE chat_id = $1`, [chatId]);

        res.json(dbMessages.rows);
    } catch (e) {
        console.error('   Messages endpoint error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Send message
app.post('/chats/:chatId/send', async (req, res) => {
    const { chatId } = req.params;
    const { message } = req.body;

    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!waClient || clientStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const sent = await waClient.sendMessage(chatId, message.trim());
        // Save to DB
        await saveMessage(sent, true);
        res.json({
            ok: true,
            message: {
                id: sent.id._serialized,
                body: sent.body,
                fromMe: true,
                timestamp: sent.timestamp * 1000,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Send message to new number
app.post('/send-new', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone?.trim() || !message?.trim()) return res.status(400).json({ error: 'Phone and message required' });
    if (!waClient || clientStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        // Format phone number
        let num = phone.replace(/[\s\-\(\)\+]/g, '');
        if (!num.endsWith('@c.us')) num = num + '@c.us';

        const sent = await waClient.sendMessage(num, message.trim());
        await saveMessage(sent, true);
        res.json({
            ok: true,
            chatId: num,
            message: {
                id: sent.id._serialized,
                body: sent.body,
                fromMe: true,
                timestamp: sent.timestamp * 1000,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Search chats
app.get('/search', async (req, res) => {
    const q = req.query.q || '';
    try {
        const result = await pool.query(`
            SELECT * FROM wa_conversations
            WHERE name ILIKE $1 OR phone ILIKE $1
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT 50
        `, [`%${q}%`]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── WebSocket connections ───
wss.on('connection', (ws) => {
    console.log('🔗 WebSocket client connected');
    ws.send(JSON.stringify({ type: 'status', status: clientStatus }));
});

// ─── Start ───
const PORT = process.env.PORT || 3001;

initDB().then(() => {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`🟢 WhatsApp service running on port ${PORT}`);
        // Auto-initialize WhatsApp client
        createWAClient();
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
