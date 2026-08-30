const nodeCrypto = require("crypto");

// WebCrypto must exist before Baileys is loaded
if (!globalThis.crypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
}

if (!global.crypto) {
    global.crypto = nodeCrypto.webcrypto;
}

require("dotenv").config();

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs-extra");
const path = require("path");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    delay
} = require("@whiskeysockets/baileys");

const P = require("pino");
const settings = require("./settings");

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const AUTH_DIR = path.join(__dirname, "auth_info");

fs.ensureDirSync(AUTH_DIR);

const sessions = {};
const userSockets = {};

class BotSession {

    constructor(userId) {
        this.userId = userId;
        this.sock = null;
        this.isConnected = false;
        this.authPath = path.join(AUTH_DIR, userId);
        this.isPublic = true;
        this.antilink = false;
        this.initializing = false;
    }

    sendConnectionStatus() {

        const socketId = userSockets[this.userId];

        if (socketId) {
            io.to(socketId).emit("connection-status", {
                connected: this.isConnected
            });
        }
    }

    sendPairError(message) {

        const socketId = userSockets[this.userId];

        if (socketId) {
            io.to(socketId).emit(
                "pair-error",
                message || "Pairing failed"
            );
        }
    }

    async initialize(pairingNumber = null) {

        if (this.initializing) {
            return;
        }

        this.initializing = true;

        try {

            const { version } = await fetchLatestBaileysVersion();

            const { state, saveCreds } =
                await useMultiFileAuthState(this.authPath);

            this.sock = makeWASocket({

                version,

                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        P({
                            level: "silent"
                        })
                    )
                },

                logger: P({
                    level: "silent"
                }),

                browser: Browsers.ubuntu("Chrome"),

                syncFullHistory: false,

                markOnlineOnConnect: false
            });

            /*
             * PAIRING
             */

            if (
                pairingNumber &&
                !state.creds.registered
            ) {

                await delay(3000);

                const cleanNumber = String(pairingNumber)
                    .replace(/\D/g, "");

                if (!cleanNumber) {
                    throw new Error(
                        "Invalid WhatsApp number"
                    );
                }

                console.log(
                    `[PAIRING] Requesting code for ${cleanNumber}`
                );

                try {

                    let code =
                        await this.sock.requestPairingCode(
                            cleanNumber
                        );

                    code =
                        code
                            ?.match(/.{1,4}/g)
                            ?.join("-") ||
                        code;

                    console.log(
                        `[PAIRING] Code generated: ${code}`
                    );

                    const socketId =
                        userSockets[this.userId];

                    if (socketId) {

                        io.to(socketId).emit(
                            "pairing-code",
                            code
                        );
                    }

                } catch (err) {

                    console.error(
                        "[PAIRING ERROR]",
                        err
                    );

                    this.sendPairError(
                        err.message ||
                        "Unable to generate pairing code"
                    );
                }
            }

            this.sock.ev.on(
                "creds.update",
                saveCreds
            );

            this.sock.ev.on(
                "connection.update",
                async (update) => {

                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    if (connection === "open") {

                        this.isConnected = true;
                        this.initializing = false;

                        console.log(
                            `[CONNECTED] ${this.userId}`
                        );

                        this.sendConnectionStatus();

                        try {

                            const botNumber =
                                jidNormalizedUser(
                                    this.sock.user.id
                                );

                            await this.sock.sendMessage(
                                botNumber,
                                {
                                    text:
                                        `*${settings.botName}*\n\n` +
                                        `Connected Successfully!\n\n` +
                                        `Type *${settings.prefix}menu* for commands.\n\n` +
                                        `© ${settings.footer}`
                                }
                            );

                        } catch (err) {

                            console.error(
                                "[START MESSAGE ERROR]",
                                err.message
                            );
                        }

                        return;
                    }

                    if (connection === "close") {

                        this.isConnected = false;
                        this.initializing = false;

                        const statusCode =
                            lastDisconnect
                                ?.error
                                ?.output
                                ?.statusCode;

                        console.log(
                            `[DISCONNECTED] ${this.userId}`,
                            statusCode
                        );

                        this.sendConnectionStatus();

                        if (
                            statusCode ===
                            DisconnectReason.loggedOut
                        ) {

                            delete sessions[this.userId];

                            console.log(
                                `[LOGGED OUT] ${this.userId}`
                            );

                        } else {

                            console.log(
                                `[RECONNECTING] ${this.userId}`
                            );

                            setTimeout(() => {

                                if (
                                    sessions[this.userId]
                                ) {

                                    sessions[
                                        this.userId
                                    ].initialize();

                                }

                            }, 5000);
                        }
                    }
                }
            );

            /*
             * MESSAGE HANDLER
             */

            this.sock.ev.on(
                "messages.upsert",
                async (m) => {

                    if (m.type !== "notify") {
                        return;
                    }

                    for (const msg of m.messages) {

                        try {

                            if (!msg.message) {
                                continue;
                            }

                            const from =
                                msg.key.remoteJid;

                            if (!from) {
                                continue;
                            }

                            const text =
                                msg.message.conversation ||
                                msg.message.extendedTextMessage
                                    ?.text ||
                                "";

                            const cleanText =
                                text.trim();

                            if (!cleanText) {
                                continue;
                            }

                            if (
                                msg.key.fromMe
                            ) {
                                continue;
                            }

                            if (
                                !cleanText.startsWith(
                                    settings.prefix
                                )
                            ) {
                                continue;
                            }

                            const commandName =
                                cleanText
                                    .slice(
                                        settings.prefix.length
                                    )
                                    .trim()
                                    .split(/\s+/)[0]
                                    .toLowerCase();

                            const q =
                                cleanText
                                    .split(/\s+/)
                                    .slice(1)
                                    .join(" ");

                            const isGroup =
                                from.endsWith("@g.us");

                            const botNumber =
                                jidNormalizedUser(
                                    this.sock.user.id
                                );

                            const botNumberClean =
                                botNumber.split("@")[0];

                            const sender =
                                msg.key.participant ||
                                from;

                            const senderClean =
                                sender.split("@")[0];

                            const ownerNumbers =
                                String(
                                    settings.ownerNumber
                                )
                                    .split(",")
                                    .map((n) =>
                                        n.replace(/\D/g, "")
                                    );

                            const isOwner =
                                ownerNumbers.includes(
                                    senderClean
                                ) ||
                                senderClean ===
                                    botNumberClean;

                            /*
                             * ANTILINK
                             */

                            if (
                                isGroup &&
                                this.antilink &&
                                !isOwner
                            ) {

                                if (
                                    /https?:\/\//i.test(
                                        cleanText
                                    ) ||
                                    /chat\.whatsapp\.com/i.test(
                                        cleanText
                                    )
                                ) {

                                    try {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    "Links are disabled in this group."
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    } catch (e) {}

                                    continue;
                                }
                            }

                            /*
                             * COMMANDS
                             */

                            switch (commandName) {

                                case "menu": {

                                    const menu =
                                        `*${settings.botName}*\n\n` +
                                        `*Available Commands*\n\n` +
                                        `${settings.prefix}menu\n` +
                                        `${settings.prefix}ping\n` +
                                        `${settings.prefix}alive\n` +
                                        `${settings.prefix}owner\n` +
                                        `${settings.prefix}runtime\n` +
                                        `${settings.prefix}groupinfo\n` +
                                        `${settings.prefix}antilink on/off\n` +
                                        `${settings.prefix}public on/off\n\n` +
                                        `© ${settings.footer}`;

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text: menu
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "ping": {

                                    const start =
                                        Date.now();

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `Pong! ${
                                                    Date.now() -
                                                    start
                                                }ms`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "alive": {

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `*${settings.botName}*\n\n` +
                                                `Bot is online and active.\n\n` +
                                                `© ${settings.footer}`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "owner": {

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `*Owner Details*\n\n` +
                                                `Name: ${settings.botOwner}\n` +
                                                `Team: ${settings.teamName}\n` +
                                                `Number: ${settings.ownerNumber}\n` +
                                                `Email: ${settings.ownerEmail}\n\n` +
                                                `© ${settings.footer}`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "runtime": {

                                    const seconds =
                                        Math.floor(
                                            process.uptime()
                                        );

                                    const hours =
                                        Math.floor(
                                            seconds / 3600
                                        );

                                    const minutes =
                                        Math.floor(
                                            (seconds % 3600) /
                                            60
                                        );

                                    const secs =
                                        seconds % 60;

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `*Runtime*\n\n` +
                                                `${hours}h ${minutes}m ${secs}s`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "groupinfo": {

                                    if (!isGroup) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    "This command can only be used in a group."
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                        break;
                                    }

                                    try {

                                        const metadata =
                                            await this.sock.groupMetadata(
                                                from
                                            );

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    `*Group Info*\n\n` +
                                                    `Name: ${metadata.subject}\n` +
                                                    `Members: ${metadata.participants.length}\n` +
                                                    `Owner: ${metadata.owner || "Unknown"}`
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                    } catch (err) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    "Unable to get group information."
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );
                                    }

                                    break;
                                }

                                case "antilink": {

                                    if (!isOwner) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    "Owner only."
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                        break;
                                    }

                                    const option =
                                        q.toLowerCase();

                                    if (
                                        ![
                                            "on",
                                            "off"
                                        ].includes(option)
                                    ) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    `Example: ${settings.prefix}antilink on`
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                        break;
                                    }

                                    this.antilink =
                                        option === "on";

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `Antilink ${
                                                    this.antilink
                                                        ? "enabled"
                                                        : "disabled"
                                                }.`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                case "public": {

                                    if (!isOwner) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    "Owner only."
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                        break;
                                    }

                                    const option =
                                        q.toLowerCase();

                                    if (
                                        ![
                                            "on",
                                            "off"
                                        ].includes(option)
                                    ) {

                                        await this.sock.sendMessage(
                                            from,
                                            {
                                                text:
                                                    `Example: ${settings.prefix}public on`
                                            },
                                            {
                                                quoted: msg
                                            }
                                        );

                                        break;
                                    }

                                    this.isPublic =
                                        option === "on";

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `Public mode ${
                                                    this.isPublic
                                                        ? "enabled"
                                                        : "disabled"
                                                }.`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );

                                    break;
                                }

                                default: {

                                    await this.sock.sendMessage(
                                        from,
                                        {
                                            text:
                                                `Unknown command.\n\nType ${settings.prefix}menu`
                                        },
                                        {
                                            quoted: msg
                                        }
                                    );
                                }
                            }

                        } catch (err) {

                            console.error(
                                "[MESSAGE ERROR]",
                                err.message
                            );
                        }
                    }
                }
            );

        } catch (err) {

            this.initializing = false;

            console.error(
                "[INIT ERROR]",
                err
            );

            this.sendPairError(
                err.message ||
                "Bot initialization failed"
            );
        }
    }
}

/*
 * SOCKET.IO
 */

io.on(
    "connection",
    (socket) => {

        console.log(
            "[SOCKET] Connected:",
            socket.id
        );

        socket.on(
            "set-user",
            (userId) => {

                if (!userId) {
                    return;
                }

                userSockets[userId] =
                    socket.id;

                if (!sessions[userId]) {

                    sessions[userId] =
                        new BotSession(
                            userId
                        );
                }

                sessions[userId]
                    .sendConnectionStatus();
            }
        );

        socket.on(
            "pair-request",
            async ({ userId, number }) => {

                try {

                    if (!userId || !number) {

                        socket.emit(
                            "pair-error",
                            "User ID or number missing."
                        );

                        return;
                    }

                    if (!sessions[userId]) {

                        sessions[userId] =
                            new BotSession(
                                userId
                            );
                    }

                    userSockets[userId] =
                        socket.id;

                    await sessions[userId]
                        .initialize(number);

                } catch (err) {

                    console.error(
                        "[PAIR REQUEST ERROR]",
                        err
                    );

                    socket.emit(
                        "pair-error",
                        err.message ||
                        "Pairing failed"
                    );
                }
            }
        );

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "[SOCKET] Disconnected:",
                    socket.id
                );

                for (
                    const userId in userSockets
                ) {

                    if (
                        userSockets[userId] ===
                        socket.id
                    ) {

                        delete userSockets[
                            userId
                        ];
                    }
                }
            }
        );
    }
);

/*
 * SERVER
 */

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `MA CRASHER Server running on port ${PORT}`
        );

        console.log(
            `Node version: ${process.version}`
        );

        console.log(
            `WebCrypto: ${
                !!globalThis.crypto
            }`
        );
    }
);
