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


// STATUS

app.get("/status", (req, res) => {
    res.json({
        status: botStatus,
        pairingCode: pairingCode
    });
});


// GENERATE PAIRING CODE

app.post("/pair", async (req, res) => {

    if (isStarting) {
        return res.status(429).json({
            success: false,
            message: "Pairing request already in progress"
        });
    }

    try {

        let number = req.body.number;

        if (!number) {
            return res.status(400).json({
                success: false,
                message: "Phone number is required"
            });
        }

        // Remove +, spaces and other characters
        number = number.replace(/[^0-9]/g, "");

        // Convert Pakistani local number
        // 03001234567 -> 923001234567
        if (number.startsWith("0")) {
            number = "92" + number.substring(1);
        }

        isStarting = true;

        console.log("================================");
        console.log("STARTING WHATSAPP PAIRING");
        console.log("NUMBER:", number);
        console.log("================================");

        const code = await startBot(number);

        res.json({
            success: true,
            pairingCode: code
        });

    } catch (error) {

        console.error("PAIRING ERROR:", error);

        botStatus = "Error";

        res.status(500).json({
            success: false,
            message: error.message || "Failed to generate pairing code"
        });

    } finally {

        isStarting = false;

    }

});


// START BOT

async function startBot(number) {

    const { state, saveCreds } =
        await useMultiFileAuthState("./session");


    sock = makeWASocket({

        auth: state,

        printQRInTerminal: false,

        markOnlineOnConnect: false,

        syncFullHistory: false

    });


    // SAVE SESSION

    sock.ev.on("creds.update", saveCreds);


    // IF ALREADY LOGGED IN

    if (state.creds.registered) {

        botStatus = "Already Connected";

        console.log("Session already registered.");

        return null;

    }


    botStatus = "Connecting";


    return new Promise((resolve, reject) => {

        let pairingRequested = false;
        let finished = false;


        sock.ev.on(
            "connection.update",

            async (update) => {

                const {
                    connection,
                    lastDisconnect
                } = update;


                console.log(
                    "Connection Update:",
                    connection || "initializing"
                );


                // REQUEST PAIRING CODE

                if (
                    !pairingRequested &&
                    !finished &&
                    connection === "connecting"
                ) {

                    pairingRequested = true;


                    try {

                        console.log(
                            "Requesting pairing code..."
                        );


                        // Wait briefly for socket initialization

                        await new Promise(resolve =>
                            setTimeout(resolve, 1000)
                        );


                        const code =
                            await sock.requestPairingCode(number);


                        pairingCode = code;


                        botStatus =
                            "Pairing Code Generated";


                        finished = true;


                        console.log("");
                        console.log("==============================");
                        console.log(
                            "PAIRING CODE:",
                            pairingCode
                        );
                        console.log("==============================");
                        console.log("");


                        resolve(pairingCode);


                    } catch (error) {

                        console.error(
                            "PAIRING CODE ERROR:",
                            error
                        );


                        finished = true;

                        reject(error);

                    }

                }


                // CONNECTED

                if (connection === "open") {

                    botStatus = "Connected";

                    pairingCode = null;


                    console.log(
                        "WHATSAPP CONNECTED SUCCESSFULLY"
                    );

                }


                // CONNECTION CLOSED

                if (connection === "close") {

                    const statusCode =
                        lastDisconnect?.error
                            ?.output
                            ?.statusCode;


                    console.log(
                        "CONNECTION CLOSED:",
                        statusCode
                    );


                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {

                        botStatus = "Logged Out";

                    } else {

                        botStatus = "Disconnected";

                    }


                    // Reject only if pairing wasn't completed

                    if (!finished) {

                        finished = true;

                        reject(
                            new Error(
                                `Connection closed before pairing (${statusCode || "unknown"})`
                            )
                        );

                    }

                }

            }
        );

    });

}


// SERVER

app.listen(PORT, "0.0.0.0", () => {

    console.log("================================");
    console.log("WHATSAPP PAIRING TEST SERVER");
    console.log(`PORT: ${PORT}`);
    console.log("================================");

});
