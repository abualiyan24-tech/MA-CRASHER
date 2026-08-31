const crypto = require("crypto");

if (!global.crypto) {
    global.crypto = crypto.webcrypto;
}

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
let isStarting = false;


// HOME PAGE

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});


// STATUS API

app.get("/status", (req, res) => {

    res.json({
        status: botStatus,
        pairingCode: pairingCode
    });

});


// GENERATE PAIRING CODE

app.post("/pair", async (req, res) => {

    try {

        let number = req.body.number;

        if (!number) {

            return res.status(400).json({
                success: false,
                message: "Phone number required"
            });

        }


        number = number.replace(/[^0-9]/g, "");


        if (isStarting) {

            return res.json({
                success: false,
                message: "Bot is already starting"
            });

        }


        isStarting = true;


        console.log("Starting WhatsApp connection...");
        console.log("Number:", number);


        const code = await startBot(number);


        res.json({
            success: true,
            pairingCode: code
        });


    } catch (error) {

        console.error("PAIR ERROR:", error);


        res.status(500).json({
            success: false,
            message: error.message
        });

    } finally {

        isStarting = false;

    }

});


// START BOT

async function startBot(number) {


    const {
        state,
        saveCreds
    } = await useMultiFileAuthState("./session");


    sock = makeWASocket({

        auth: state,

        printQRInTerminal: false,

        browser: [
            "MA Test Bot",
            "Chrome",
            "1.0.0"
        ]

    });


    // SAVE SESSION

    sock.ev.on(
        "creds.update",
        saveCreds
    );


    // CONNECTION STATUS

    sock.ev.on(
        "connection.update",
        async (update) => {


            const {
                connection,
                lastDisconnect
            } = update;


            if (connection === "connecting") {

                botStatus = "Connecting";

                console.log(
                    "Connecting to WhatsApp..."
                );

            }


            if (connection === "open") {

                botStatus = "Connected";

                pairingCode = null;


                console.log(
                    "WhatsApp Connected Successfully"
                );

            }


            if (connection === "close") {


                botStatus = "Disconnected";


                const statusCode =
                    lastDisconnect?.error
                        ?.output
                        ?.statusCode;


                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;


                console.log(
                    "Connection closed"
                );


                console.log(
                    "Status Code:",
                    statusCode
                );


                if (shouldReconnect) {

                    console.log(
                        "Connection closed. Reconnect may be required."
                    );

                }

            }

        }
    );


    // GENERATE PAIRING CODE

    if (!state.creds.registered) {

        botStatus =
            "Generating Pairing Code";


        console.log(
            "Generating pairing code..."
        );


        pairingCode =
            await sock.requestPairingCode(
                number
            );


        botStatus =
            "Pairing Code Generated";


        console.log(
            "PAIRING CODE:",
            pairingCode
        );


        return pairingCode;

    }


    // ALREADY REGISTERED

    botStatus =
        "Already Connected";


    return null;

}


// SERVER

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Server running on port ${PORT}`
    );

});
