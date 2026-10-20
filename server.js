require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_0d9AsMrUQaxu@ep-cold-boat-azyganzb-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err) => {
    if (err) { console.error('❌ DB connection failed:', err.stack); process.exit(1); }
    else console.log('✅ Database connected');
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- AUDIO UPLOAD CONFIG ----------
const audioUploadDir = path.join(__dirname, 'audio_uploads');
if (!fs.existsSync(audioUploadDir)) {
    fs.mkdirSync(audioUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, audioUploadDir);
    },
    filename: function (req, file, cb) {
        const imei = req.body.imei || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname) || '.amr';
        cb(null, `${imei}_${timestamp}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Rate limiter disabled for personal use
// const limiter = rateLimit({ windowMs: 900000, max: 100 });
// app.use('/api/', limiter);

function generateToken(user) {
    return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'No token' });
    const token = auth.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Invalid token' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid/expired token' });
    req.user = decoded;
    next();
}

// AUTH
app.post('/api/auth/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('full_name').optional().trim(),
    body('phone').optional().trim(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { email, password, full_name, phone } = req.body;
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });
        const hashed = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, phone)
             VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, phone`,
            [email, hashed, full_name || null, phone || null]
        );
        const user = result.rows[0];
        const token = generateToken(user);
        res.status(201).json({ success: true, token, user: { id: user.id, email: user.email, full_name: user.full_name, phone: user.phone } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT id, email, password_hash, full_name, phone FROM users WHERE email = $1 AND is_active = true', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = generateToken(user);
        res.json({ success: true, token, user: { id: user.id, email: user.email, full_name: user.full_name, phone: user.phone } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// DEVICES
app.post('/api/devices', authenticate, [
    body('imei').notEmpty().isLength({ min: 15, max: 20 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { imei, sim_serial, device_id, brand, model, android_version } = req.body;
        const userId = req.user.id;
        const existing = await pool.query('SELECT id FROM devices WHERE imei = $1', [imei]);
        if (existing.rows.length > 0) {
            await pool.query(
                `UPDATE devices SET user_id = $1, sim_serial = $2, device_id = $3, brand = $4, model = $5, android_version = $6, last_seen = NOW(), status = 'active' WHERE imei = $7`,
                [userId, sim_serial, device_id, brand, model, android_version, imei]
            );
            return res.json({ success: true, message: 'Device updated' });
        }
        await pool.query(
            `INSERT INTO devices (user_id, imei, sim_serial, device_id, brand, model, android_version, last_seen) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [userId, imei, sim_serial, device_id, brand, model, android_version]
        );
        res.json({ success: true, message: 'Device registered' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Device registration failed' });
    }
});

app.get('/api/devices', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT id, imei, brand, model, android_version, last_location, last_location_timestamp, last_seen, status, is_blacklisted, TO_CHAR(registered_at, 'YYYY-MM-DD HH24:MI:SS') as registered_at FROM devices WHERE user_id = $1 ORDER BY last_seen DESC NULLS LAST`,
            [userId]
        );
        res.json({ success: true, devices: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch devices' });
    }
});

app.post('/api/devices/:imei/stolen', authenticate, async (req, res) => {
    try {
        const { imei } = req.params;
        const userId = req.user.id;
        const result = await pool.query(`UPDATE devices SET status = 'stolen', last_seen = NOW() WHERE imei = $1 AND user_id = $2 RETURNING id`, [imei, userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
        await pool.query(`INSERT INTO imei_blacklist (imei, reason, reported_by, is_national) VALUES ($1, 'stolen', $2, true) ON CONFLICT (imei) DO UPDATE SET reason = 'stolen', reported_by = $2`, [imei, userId]);
        const contacts = await pool.query(`SELECT contact_email, contact_phone FROM trusted_contacts WHERE user_id = $1 AND is_active = true`, [userId]);
        for (const c of contacts.rows) {
            if (c.contact_email) {
                await transporter.sendMail({
                    from: `"Last Breath" <${process.env.SMTP_USER}>`,
                    to: c.contact_email,
                    subject: '🔴 Phone Stolen Alert!',
                    text: `Your trusted contact's phone (IMEI: ${imei}) has been reported stolen. Check dashboard.`
                });
            }
        }
        res.json({ success: true, message: 'Device marked as stolen' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark stolen' });
    }
});

app.post('/api/devices/:imei/recovered', authenticate, async (req, res) => {
    try {
        const { imei } = req.params;
        const userId = req.user.id;
        const result = await pool.query(`UPDATE devices SET status = 'recovered', last_seen = NOW() WHERE imei = $1 AND user_id = $2 RETURNING id`, [imei, userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
        await pool.query(`DELETE FROM imei_blacklist WHERE imei = $1`, [imei]);
        res.json({ success: true, message: 'Device marked as recovered' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to mark recovered' });
    }
});

// LOCATION
app.post('/api/location', async (req, res) => {
    try {
        const { imei, location } = req.body;
        if (!imei || !location) return res.status(400).json({ error: 'Missing fields' });
        const result = await pool.query(`UPDATE devices SET last_location = $1, last_location_timestamp = NOW(), last_seen = NOW() WHERE imei = $2 RETURNING user_id, status`, [location, imei]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
        const { user_id, status } = result.rows[0];
        if (status === 'stolen') {
            const user = await pool.query('SELECT email, phone FROM users WHERE id = $1', [user_id]);
            if (user.rows.length > 0 && user.rows[0].email) {
                try {
                    await transporter.sendMail({
                        from: `"Last Breath" <${process.env.SMTP_USER}>`,
                        to: user.rows[0].email,
                        subject: '📍 Your stolen phone has been located!',
                        text: `Your phone (IMEI: ${imei}) was located at: ${location}\nTime: ${new Date().toISOString()}`
                    });
                    console.log('✅ Email alert sent successfully.');
                } catch (emailError) {
                    console.error('⚠️ Email failed:', emailError.message);
                }
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Location update failed' });
    }
});

// ALERTS
app.post('/api/alerts', async (req, res) => {
    try {
        const { imei, location, message, alert_type } = req.body;
        if (!imei) return res.status(400).json({ error: 'IMEI required' });
        const device = await pool.query('SELECT id, user_id FROM devices WHERE imei = $1', [imei]);
        if (device.rows.length === 0) return res.status(404).json({ error: 'Device not found' });
        const device_id = device.rows[0].id;
        const user_id = device.rows[0].user_id;
        await pool.query(`INSERT INTO alerts (device_id, alert_type, location, message) VALUES ($1, $2, $3, $4)`, [device_id, alert_type || 'security', location || null, message || null]);
        if (location) {
            await pool.query(`UPDATE devices SET last_location = $1, last_location_timestamp = NOW(), last_seen = NOW() WHERE id = $2`, [location, device_id]);
        }
        const contacts = await pool.query(`SELECT contact_email, contact_phone FROM trusted_contacts WHERE user_id = $1 AND is_active = true`, [user_id]);
        const msg = `🔴 ALERT: ${message || 'Security alert'} on device ${imei}\nLocation: ${location || 'Unknown'}\nTime: ${new Date().toISOString()}`;
        for (const c of contacts.rows) {
            if (c.contact_email) {
                await transporter.sendMail({ from: `"Last Breath" <${process.env.SMTP_USER}>`, to: c.contact_email, subject: '🔴 Security Alert - Last Breath', text: msg });
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Alert processing failed' });
    }
});

app.get('/api/alerts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 50;
        const result = await pool.query(
            `SELECT a.id, a.alert_type, a.location, a.message, TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at, a.is_resolved, d.imei, d.brand, d.model FROM alerts a JOIN devices d ON a.device_id = d.id WHERE d.user_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
            [userId, limit]
        );
        res.json({ success: true, alerts: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch alerts' });
    }
});

// CONTACTS
app.post('/api/contacts', authenticate, [
    body('contact_name').notEmpty().trim(),
    body('contact_phone').optional(),
    body('contact_email').optional().isEmail(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
        const { contact_name, contact_phone, contact_email } = req.body;
        const userId = req.user.id;
        if (!contact_phone && !contact_email) return res.status(400).json({ error: 'Phone or email required' });
        await pool.query(`INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email) VALUES ($1, $2, $3, $4)`, [userId, contact_name, contact_phone || null, contact_email || null]);
        res.json({ success: true, message: 'Contact added' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add contact' });
    }
});

app.get('/api/contacts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(`SELECT id, contact_name, contact_phone, contact_email, is_active, TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at FROM trusted_contacts WHERE user_id = $1 ORDER BY id`, [userId]);
        res.json({ success: true, contacts: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

app.delete('/api/contacts/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        await pool.query('DELETE FROM trusted_contacts WHERE id = $1 AND user_id = $2', [id, userId]);
        res.json({ success: true, message: 'Contact deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete contact' });
    }
});

// STATS
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const devices = await pool.query('SELECT COUNT(*) as count FROM devices WHERE user_id = $1', [userId]);
        const alerts = await pool.query('SELECT COUNT(*) as count FROM alerts a JOIN devices d ON a.device_id = d.id WHERE d.user_id = $1 AND a.is_resolved = false', [userId]);
                const contacts = await pool.query('SELECT COUNT(*) as count FROM trusted_contacts WHERE user_id = $1 AND is_active = true', [userId]);
        
        // NEW: Count blacklisted devices
        const blacklist = await pool.query('SELECT COUNT(*) as count FROM imei_blacklist WHERE reported_by = $1', [userId]);
        
        res.json({ success: true, stats: { 
            devices: parseInt(devices.rows[0].count), 
            pending_alerts: parseInt(alerts.rows[0].count), 
            trusted_contacts: parseInt(contacts.rows[0].count),
            blacklisted: parseInt(blacklist.rows[0].count) // <-- ADDED
        } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ---------- HEARTBEAT ENDPOINT ----------
// ---------- HEARTBEAT ENDPOINT ----------
app.post('/api/heartbeat', async (req, res) => {
    try {
        // ADDED sim_number to the destructured variables
        const { imei, status, last_location, drm_id, sim_number } = req.body; 
        if (!imei) {
            return res.status(400).json({ error: 'IMEI required' });
        }

        // 1. Update the current device
        await pool.query(
            `UPDATE devices 
             SET last_seen = NOW(), 
                 last_location = COALESCE($1, last_location),
                 drm_id = COALESCE($2, drm_id),
                 sim_number = COALESCE($3, sim_number)
             WHERE imei = $4`,
            [last_location || null, drm_id || null, sim_number || null, imei]
        );
        // 2. THE TRAP: Check if this DRM ID belongs to a STOLEN device
        if (drm_id && drm_id !== "UNKNOWN") {
            const stolenDevice = await pool.query(
                `SELECT imei, user_id FROM devices WHERE drm_id = $1 AND status = 'stolen' AND imei != $2`,
                [drm_id, imei]
            );

            if (stolenDevice.rows.length > 0) {
                const originalOwnerId = stolenDevice.rows[0].user_id;
                const originalImei = stolenDevice.rows[0].imei;
                
                // Alert the original owner!
                const user = await pool.query('SELECT email FROM users WHERE id = $1', [originalOwnerId]);
                if (user.rows.length > 0 && user.rows[0].email) {
                    await transporter.sendMail({
                        from: `"Last Breath" <${process.env.SMTP_USER}>`,
                        to: user.rows[0].email,
                        subject: '🚨 THIEF DETECTED! Phone Re-flashed!',
                        text: `WARNING: Your stolen phone (Original IMEI: ${originalImei}) has been factory reset or re-flashed, but the thief is now using it with a NEW IMEI: ${imei}.\n\nThe hardware DRM ID matches! They are trying to bypass your security. We have logged this new IMEI.`
                    });
                }
                console.log(`🚨 DRM MATCH! Thief tried to use stolen hardware with new IMEI: ${imei}`);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Heartbeat error:', err);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ---------- COMMAND ENDPOINT (Polled by Phone) ----------
app.get('/api/commands', async (req, res) => {
    try {
        const imei = req.query.imei;
        if (!imei) return res.status(400).json({ error: 'IMEI required' });

        // Check if there is a pending command from the dashboard
        const cmdResult = await pool.query(
            `SELECT id, action FROM device_commands WHERE imei = $1 AND is_executed = FALSE ORDER BY id ASC LIMIT 1`,
            [imei]
        );

                       if (cmdResult.rows.length > 0) {
            const cmd = cmdResult.rows[0];
            await pool.query(`UPDATE device_commands SET is_executed = TRUE WHERE id = $1`, [cmd.id]);
            
            // Handle custom PIN
            if (cmd.action.startsWith('change_pin|')) {
                const parts = cmd.action.split('|');
                return res.json({ action: 'change_pin', pin: parts[1] });
            }
            // Handle custom alarms
            else if (cmd.action.startsWith('set_alarm|')) {
                const parts = cmd.action.split('|');
                return res.json({ 
                    action: 'set_alarm', 
                    hour: parseInt(parts[1]), 
                    minute: parseInt(parts[2]) 
                });
            }

            console.log(`📲 Sent command [${cmd.action}] to phone ${imei}`);
            return res.json({ action: cmd.action });
        }

                // If no dashboard commands, check for standard block/restore and polling modes
        const result = await pool.query('SELECT status, force_fast_poll FROM devices WHERE imei = $1', [imei]);
        if (result.rows.length > 0) {
            const status = result.rows[0].status;
            const forceFast = result.rows[0].force_fast_poll;

            // If the device is stolen OR manual fast poll is ON
            if (status === 'stolen' || forceFast === true) {
                // If stolen, we send the block action. If just fast poll, we send 'none'.
                const action = status === 'stolen' ? 'block' : 'none';
                return res.json({ action: action, fast_poll: true });
            }
            if (status === 'recovered') {
                return res.json({ action: 'restore', fast_poll: false });
            }
        }

        // Default normal mode (fast_poll: false)
        res.json({ action: 'none', fast_poll: false });
    } catch (err) {
        console.error('Commands error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// ---------- UPLOAD AUDIO ----------
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
    try {
        const imei = req.body.imei || 'unknown';
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No audio file uploaded' });
        }

        console.log(`📁 Audio uploaded: ${file.filename} (IMEI: ${imei})`);

        res.json({ 
            success: true, 
            message: 'Audio uploaded successfully',
            filename: file.filename,
            size: file.size
        });

    } catch (err) {
        console.error('Audio upload error:', err);
        res.status(500).json({ error: 'Audio upload failed' });
    }
});

// ---------- UPLOAD PHOTO ----------
app.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        const imei = req.body.imei || 'unknown';
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No photo uploaded' });
        }

        console.log(`📷 Photo uploaded: ${file.filename} (IMEI: ${imei})`);

        res.json({
            success: true,
            message: 'Photo uploaded successfully',
            filename: file.filename,
            size: file.size
        });
    } catch (err) {
        console.error('Photo upload error:', err);
        res.status(500).json({ error: 'Photo upload failed' });
    }
}); // <--- THIS IS THE CRUCIAL MISSING LINE

// ---------- UPLOAD VIDEO ----------
// ---------- UPLOAD VIDEO ----------
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    try {
        const imei = req.body.imei || 'unknown';
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No video uploaded' });
        }

        console.log(`🎥 Video uploaded: ${file.filename} (IMEI: ${imei})`);

        res.json({
            success: true,
            message: 'Video uploaded successfully',
            filename: file.filename,
            size: file.size
        });
    } catch (err) {
        console.error('Video upload error:', err);
        res.status(500).json({ error: 'Video upload failed' });
    }
});

// ---------- WIFI INFO (connected network) ----------
app.post('/api/wifi-info', async (req, res) => {
    try {
        const { imei, ssid, bssid, location } = req.body;
        console.log(`📶 WiFi: ${ssid} (${bssid}) for IMEI ${imei} at ${location}`);
        
        await pool.query(
            `INSERT INTO alerts (device_id, alert_type, location, message) 
             SELECT id, 'wifi', $1, $2 FROM devices WHERE imei = $3`,
            [location, `WiFi: ${ssid} (${bssid})`, imei]
        );

        // AUTO-CLEANUP: Keep only latest 100 alerts for this device
        await pool.query(`
            DELETE FROM alerts 
            WHERE id NOT IN (
                SELECT id FROM alerts a 
                JOIN devices d ON a.device_id = d.id 
                WHERE d.imei = $1 ORDER BY a.created_at DESC LIMIT 100
            ) AND device_id IN (SELECT id FROM devices WHERE imei = $1)
        `, [imei]);

                res.json({ success: true });
    } catch (err) {
        console.error('WiFi info error:', err);
        res.status(500).json({ error: 'WiFi info failed' });
    }
});

// ---------- NEARBY WIFI SCAN ----------
app.post('/api/nearby-wifi', async (req, res) => {
    try {
        const { imei, bssids, location } = req.body;
        console.log(`📶 Nearby Wi-Fi scan for IMEI ${imei}: ${bssids}`);

        await pool.query(
            `INSERT INTO alerts (device_id, alert_type, location, message) 
             SELECT id, 'wifi_scan', $1, $2 FROM devices WHERE imei = $3`,
            [location, `Nearby Wi-Fi BSSIDs: ${bssids}`, imei]
        );

        // Optionally attempt to locate the first BSSID using Mozilla Location Service (free, no key)
        if (bssids && bssids.length > 0) {
            const firstBssid = bssids.split(',')[0];
            if (firstBssid && firstBssid.length > 0) {
                try {
                    const mlsResponse = await axios.post('https://location.services.mozilla.com/v1/geolocate?key=test', {
                        wifiAccessPoints: [{ macAddress: firstBssid }]
                    });
                    if (mlsResponse.data && mlsResponse.data.location) {
                        const lat = mlsResponse.data.location.lat;
                        const lng = mlsResponse.data.location.lng;
                        console.log(`📍 MLS location from BSSID: ${lat}, ${lng}`);
                        // Update device location if accuracy is good
                        await pool.query(
                            `UPDATE devices SET last_location = $1, last_location_timestamp = NOW(), last_seen = NOW() WHERE imei = $2`,
                            [`${lat},${lng}`, imei]
                        );
                    }
                } catch (e) {
                    // MLS lookup failed, ignore
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Nearby Wi-Fi error:', err);
        res.status(500).json({ error: 'Nearby Wi-Fi failed' });
    }
});

// ---------- CELL INFO (with MLS lookup) ----------
app.post('/api/cell-info', async (req, res) => {
    try {
        const { imei, cell_info, location } = req.body;
        console.log(`📡 Cell: ${cell_info} for IMEI ${imei}`);

        await pool.query(
            `INSERT INTO alerts (device_id, alert_type, location, message) 
             SELECT id, 'cell', $1, $2 FROM devices WHERE imei = $3`,
            [location, `Cell: ${cell_info}`, imei]
        );

        // Parse cell_info format: CID:xxxx,LAC:xxxx,MCC:xxx,MNC:xx
        const parts = cell_info.split(',');
        let cid = null, lac = null, mcc = null, mnc = null;
        for (const part of parts) {
            const [key, value] = part.split(':');
            if (key === 'CID') cid = parseInt(value);
            if (key === 'LAC') lac = parseInt(value);
            if (key === 'MCC') mcc = parseInt(value);
            if (key === 'MNC') mnc = parseInt(value);
        }

        if (cid !== null && lac !== null && mcc !== null && mnc !== null) {
            try {
                const mlsResponse = await axios.post('https://location.services.mozilla.com/v1/geolocate?key=test', {
                    cellTowers: [{
                        cellId: cid,
                        locationAreaCode: lac,
                        mobileCountryCode: mcc,
                        mobileNetworkCode: mnc
                    }]
                });
                if (mlsResponse.data && mlsResponse.data.location) {
                    const lat = mlsResponse.data.location.lat;
                    const lng = mlsResponse.data.location.lng;
                    console.log(`📍 MLS location from cell: ${lat}, ${lng}`);
                    await pool.query(
                        `UPDATE devices SET last_location = $1, last_location_timestamp = NOW(), last_seen = NOW() WHERE imei = $2`,
                        [`${lat},${lng}`, imei]
                    );
                }
            } catch (e) {
                // MLS lookup failed, ignore
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Cell info error:', err);
        res.status(500).json({ error: 'Cell info failed' });
    }
});

// ---------- TEST PING ----------
app.post('/api/test-ping', async (req, res) => {
    try {
        const { imei, message } = req.body;
        console.log(`🔔 TEST PING RECEIVED from ${imei}: ${message}`);
        
        // Add it to the Alerts table so it shows on the dashboard
        await pool.query(
            `INSERT INTO alerts (device_id, alert_type, location, message) 
             SELECT id, 'security', 'Unknown', $1 FROM devices WHERE imei = $2`,
            [`TEST PING: ${message}`, imei]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Ping error:', err);
        res.status(500).json({ error: 'Ping failed' });
    }
});
// ---------- ROOT ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- DEBUG LOGS ----------
app.post('/api/debug-log', async (req, res) => {
    const { imei, action, status, message } = req.body;
    try {
        await pool.query(
            `INSERT INTO device_logs (imei, action, status, message) VALUES ($1, $2, $3, $4)`,
            [imei, action, status, message]
        );
        console.log(`[${status}] ${action} - ${message}`);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Log failed' });
    }
});

// Fetch logs for the dashboard
app.get('/api/get-logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM device_logs ORDER BY id DESC LIMIT 15');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Fetch failed' });
    }
});
// ---------- SEND COMMAND FROM DASHBOARD ----------
app.post('/api/send-command', async (req, res) => {
    try {
        // 1. ADDED 'pin' to the destructured variables
        const { imei, action, hour, minute, pin } = req.body; 
        
        let finalAction = action;
        
        // 2. ADDED the custom PIN check
        if (action === 'change_pin' && pin !== undefined) {
            finalAction = `change_pin|${pin}`;
        } 
        else if (action === 'set_alarm' && hour !== undefined && minute !== undefined) {
            finalAction = `set_alarm|${hour}|${minute}`;
        }

        await pool.query(
            `INSERT INTO device_commands (imei, action) VALUES ($1, $2)`,
            [imei, finalAction]
        );
        console.log(`📤 Dashboard queued command [${finalAction}] for device ${imei}`);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send command' });
    }
});
app.post('/api/toggle-poll', authenticate, async (req, res) => {
    try {
        const { imei, fast_mode } = req.body;
        await pool.query(`UPDATE devices SET force_fast_poll = $1 WHERE imei = $2`, [fast_mode, imei]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to toggle poll' });
    }
});
app.post('/api/clear-alerts', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        await pool.query(`
            DELETE FROM alerts 
            WHERE id NOT IN (
                SELECT id FROM alerts a 
                JOIN devices d ON a.device_id = d.id 
                WHERE d.user_id = $1 ORDER BY a.created_at DESC LIMIT 50
            ) AND device_id IN (SELECT id FROM devices WHERE user_id = $1)
        `, [userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear alerts' });
    }
});
// ---------- START ----------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
});