require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const qrcode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = {}; // Stores active session state

// Rate limiting config
const messageTracker = {}; // { sessionId: [timestamps] }
const MESSAGE_LIMIT = 10;
const TIME_WINDOW = 10 * 60 * 1000; // 10 minutes in milliseconds

// Start WhatsApp session
async function startSession(sessionId) {
    const authPath = path.join(__dirname, 'auth', sessionId);
    fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: ['MultiBot', 'Chrome', '1.0'],
    });

    sessions[sessionId] = { sock, isConnected: false, currentQR: '' };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        const qrDir = path.join(__dirname, 'qr_codes');
        fs.mkdirSync(qrDir, { recursive: true });

        const qrPath = path.join(qrDir, `${sessionId}.png`);

        if (qr) {
            await qrcode.toFile(qrPath, qr);
            sessions[sessionId].currentQR = qr;
            console.log(`📸 QR generated for session: ${sessionId}`);
        }

        if (connection === 'open') {
            console.log(`✅ Session connected: ${sessionId}`);
            sessions[sessionId].isConnected = true;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Disconnected: ${sessionId} | Code: ${statusCode}`);

            // If logged out, delete auth, session, qr and messageTracker
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`❌ Logged out: ${sessionId}`);

                // Delete auth folder
                fs.rmSync(path.join(__dirname, 'auth', sessionId), { recursive: true, force: true });
                // Delete QR code file
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                }

                delete sessions[sessionId];
                delete messageTracker[sessionId];
            } else {
                // On other disconnects, consider session expired after 2 tries, else restart session
                // You can customize this logic if needed.
                console.log(`🔁 Reconnecting session: ${sessionId}`);

                // Also remove QR and session before restart to avoid stale data
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                }
                delete sessions[sessionId];
                delete messageTracker[sessionId];

                await startSession(sessionId);
            }
        }
    });

}

// Route to get QR code
app.get('/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    if (sessions[sessionId]?.isConnected) {
        return res.status(200).send('✅ Already connected');
    }

    if (!sessions[sessionId]) {
        await startSession(sessionId);
    }

    const qrPath = path.join(__dirname, 'qr_codes', `${sessionId}.png`);

    // Wait for QR code generation
    const waitForQR = async (timeout = 10000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (fs.existsSync(qrPath)) return true;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    };

    const qrReady = await waitForQR();
    if (qrReady) {
        return res.sendFile(qrPath);
    } else {
        return res.status(504).send('QR generation timeout');
    }
});

// Send message or image with rate limiting
app.post('/send/:sessionId', upload.single('image'), async (req, res) => {
    const { sessionId } = req.params;
    const { number, message } = req.body;

    if (!sessions[sessionId]?.isConnected) {
        return res.status(400).json({ success: false, message: 'Session not connected' });
    }

    // Rate limit logic
    const now = Date.now();
    if (!messageTracker[sessionId]) messageTracker[sessionId] = [];

    // Remove timestamps older than TIME_WINDOW
    messageTracker[sessionId] = messageTracker[sessionId].filter(ts => now - ts < TIME_WINDOW);

    if (messageTracker[sessionId].length >= MESSAGE_LIMIT) {
        const retryAfter = Math.ceil((TIME_WINDOW - (now - messageTracker[sessionId][0])) / 1000);
        return res.status(429).json({
            success: false,
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        });
    }

    // Add current timestamp
    messageTracker[sessionId].push(now);

    const sock = sessions[sessionId].sock;
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

    try {
        const result = await sock.onWhatsApp(jid);
        if (!result?.[0]?.exists) {
            return res.status(404).json({ success: false, message: 'Number not registered on WhatsApp' });
        }

        let msgResponse;

        if (req.file) {
            // Send image from uploaded file
            msgResponse = await sock.sendMessage(jid, {
                image: req.file.buffer,
                mimetype: req.file.mimetype,
                caption: message,
            });
        } else if (req.body.image) {
            // Send image from URL
            const imageRes = await axios.get(req.body.image, { responseType: 'arraybuffer' });
            msgResponse = await sock.sendMessage(jid, {
                image: Buffer.from(imageRes.data),
                caption: message,
            });
        } else {
            // Send plain text message
            msgResponse = await sock.sendMessage(jid, { text: message });
        }

        res.status(200).json({ success: true, data: msgResponse, message: 'Message sent' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/send-bulk/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { numbers, message, retryFailed = false } = req.body;

    if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
        return res.status(400).json({ success: false, message: 'Invalid numbers or message' });
    }

    const session = sessions[sessionId];
    if (!session?.isConnected) {
        return res.status(400).json({ success: false, message: 'Session not connected' });
    }

    const sock = session.sock;

    const total = numbers.length;
    const report = [];

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < total; i++) {
        const number = numbers[i];
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

        console.log(`📨 Processing ${i + 1}/${total} => ${number}`);

        try {
            const [check] = await sock.onWhatsApp(jid);

            if (!check?.exists) {
                report.push({ number, status: 'skipped', reason: 'Not registered on WhatsApp' });
                skippedCount++;
                continue;
            }

            try {
                await sock.sendMessage(jid, { text: message });
                report.push({ number, status: 'sent' });
                successCount++;
            } catch (sendErr) {
                console.error(`❌ Send error to ${number}:`, sendErr.message);

                if (retryFailed) {
                    console.log(`🔁 Retrying for ${number}...`);
                    try {
                        await delay(2000); // wait before retry
                        await sock.sendMessage(jid, { text: message });
                        report.push({ number, status: 'sent (retry)' });
                        successCount++;
                    } catch (retryErr) {
                        report.push({ number, status: 'failed', reason: `Retry failed: ${retryErr.message}` });
                        failCount++;
                    }
                } else {
                    report.push({ number, status: 'failed', reason: sendErr.message });
                    failCount++;
                }
            }

        } catch (err) {
            console.error(`⚠️ Unexpected error for ${number}:`, err.message);
            report.push({ number, status: 'failed', reason: err.message });
            failCount++;
        }

        // Prevent rate-limiting
        await delay(500);
    }

    const processedCount = successCount + failCount + skippedCount;

    res.status(200).json({
        success: true,
        summary: {
            total,
            processed: processedCount,
            sent: successCount,
            failed: failCount,
            skipped: skippedCount
        },
        report
    });
});


// Health check
app.get('/', (req, res) => {
    res.send('✅ WhatsApp Multi-Session Bot Running');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    fs.mkdirSync('./auth', { recursive: true });
    fs.mkdirSync('./qr_codes', { recursive: true });
    console.log(`🚀 Server started on http://localhost:${PORT}`);
});
