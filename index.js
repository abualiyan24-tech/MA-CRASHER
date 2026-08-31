const express = require("express");
const path = require("path");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let sock = null;
let pairingCode = null;
let botStatus = "Disconnected";

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/status", (req, res) => {
    res.json({
        status: botStatus,
        pairingCode: pairingCode
    });
});

app.post("/pair", async (req, res) => {
    try {
        let number = req.body.number;

        if (!number) {
            return res.json({
                success: false,
                message: "Phone number required"
            });
        }

        number = number.replace(/[^0-9]/g, "");

        await startBot(number);

        res.json({
            success: true,
            pairingCode: pairingCode
        });

    } catch (error) {
        console.error(error);

        res.json({
            success: false,
            message: error.message
        });
    }
});

async function startBot(number) {

    const { state, saveCreds } =
        await useMultiFileAuthState("./session");

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["MA Test Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            botStatus = "Connected";
            pairingCode = null;

            console.log("✅ WhatsApp Connected");
        }

        if (connection === "close") {

            botStatus = "Disconnected";

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;

            console.log("❌ Connection Closed");

            if (shouldReconnect) {
                console.log("🔄 Reconnecting...");
            }
        }
    });

    if (!state.creds.registered) {

        console.log("📱 Generating pairing code...");

        pairingCode =
            await sock.requestPairingCode(number);

        console.log(`🔑 Pairing Code: ${pairingCode}`);

        botStatus = "Pairing Code Generated";
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
