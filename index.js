const crypto = require("crypto");

if (!global.crypto) {
    global.crypto = crypto.webcrypto;
}

const express = require("express");
const path = require("path");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require("@whiskeysockets/baileys");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));


let sock = null;
let pairingCode = null;
let botStatus = "Disconnected";
let isStarting = false;


// HOME

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "index.html")
    );
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

    try {

        let number = req.body.number;


        if (!number) {

            return res.status(400).json({
                success: false,
                message: "Phone number required"
            });

        }


        // Remove +, spaces, brackets, etc.

        number = number.replace(/[^0-9]/g, "");


        // Pakistan local number support

        if (number.startsWith("0")) {

            number = "92" + number.substring(1);

        }


        // Prevent multiple requests

        if (isStarting) {

            return res.status(400).json({
                success: false,
                message: "Please wait. Pairing is already starting."
            });

        }


        isStarting = true;


        console.log("");
        console.log("================================");
        console.log("Starting WhatsApp pairing...");
        console.log("Number:", number);
        console.log("================================");


        const code = await startBot(number);


        if (!code) {

            return res.json({
                success: false,
                message: "Account is already registered."
            });

        }


        res.json({
            success: true,
            pairingCode: code
        });


    } catch (error) {


        console.error("");
        console.error("PAIRING ERROR:");
        console.error(error);
        console.error("");


        botStatus = "Error";


        res.status(500).json({
            success: false,
            message: error.message || "Failed to generate pairing code"
        });


    } finally {

        isStarting = false;

    }

});


// START WHATSAPP

async function startBot(number) {


    const {

        state,
        saveCreds

    } = await useMultiFileAuthState("./session");


    sock = makeWASocket({

        auth: state,

        printQRInTerminal: false,

        browser: Browsers.macOS("Desktop"),

        markOnlineOnConnect: false,

        syncFullHistory: false

    });


    // SAVE SESSION

    sock.ev.on(
        "creds.update",
        saveCreds
    );


    // CONNECTION UPDATE

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


                console.log("");
                console.log(
                    "WhatsApp Connected Successfully"
                );
                console.log("");

            }


            if (connection === "close") {


                const error =
                    lastDisconnect?.error;


                const statusCode =
                    error?.output?.statusCode;


                console.log("");
                console.log(
                    "Connection Closed"
                );

                console.log(
                    "Status Code:",
                    statusCode
                );


                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {

                    botStatus =
                        "Logged Out";


                    console.log(
                        "Logged out from WhatsApp."
                    );

                } else {

                    botStatus =
                        "Disconnected";


                    console.log(
                        "Connection disconnected."
                    );

                }


                console.log("");

            }


        }

    );


    // REQUEST PAIRING CODE

    if (!state.creds.registered) {


        botStatus =
            "Generating Pairing Code";


        console.log(
            "Generating pairing code..."
        );


        // Small delay for connection initialization

        await new Promise(
            resolve => setTimeout(resolve, 1500)
        );


        pairingCode =
            await sock.requestPairingCode(number);


        pairingCode =
            pairingCode?.match(/.{1,4}/g)?.join("-")
            || pairingCode;


        botStatus =
            "Pairing Code Generated";


        console.log("");
        console.log("==============================");
        console.log(
            "PAIRING CODE:",
            pairingCode
        );
        console.log("==============================");
        console.log("");


        return pairingCode;

    }


    // ALREADY REGISTERED

    botStatus =
        "Already Registered";


    console.log(
        "Session already registered."
    );


    return null;

}


// SERVER

app.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log(
        `Server running on port ${PORT}`
    );
    console.log("");

});
