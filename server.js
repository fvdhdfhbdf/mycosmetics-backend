// mycosmetics backend
//
// A deliberately tiny HTTP service: every instance of the mycosmetics Fabric
// mod (yours and everyone else's) calls this instead of going through the
// Minecraft server, so cosmetics can be visible to other players on ANY
// server - including ones that don't (and can't) have the mod installed.
//
// Storage is a single JSON file on disk. That's plenty for a hobby/friend-
// group mod; if you outgrow it, swap `readData`/`writeData` below for a real
// database without touching anything else.
//
// SECURITY NOTE: there is no way for this server to verify that a request
// claiming to be UUID X actually came from the real player X - that would
// require validating against Mojang's session servers, considerably more
// than a hobby cosmetics backend needs. The optional API_KEY below only
// stops randoms who don't have your mod/key from writing at all; it does
// NOT stop one of your players from spoofing another player's UUID. Treat
// this as "good enough for friends," not "tamper-proof."

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || ''; // set this to require the X-Api-Key header on writes; leave blank to allow open writes (dev only!)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// Keep this in sync with CosmeticType#validIds() on the client - anything
// not in here is rejected instead of silently stored, so a typo'd/garbage
// value from a broken client can't end up rendered (or crash a renderer
// that assumes every id resolves to a known texture).
const VALID_IDS = {
    CAPE: ['none', 'sharingan', 'itachi', 'sasuke', 'money'],
    HAT: ['none', 'top_hat', 'party_hat'],
    WINGS: ['none', 'heaven'],
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function readData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        console.error('Failed to read data file, starting from an empty store:', err);
        return {};
    }
}

function writeData(data) {
    // Synchronous + atomic-ish (write temp, rename) so a crash mid-write
    // can't leave data.json half-written/corrupted.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

let data = readData();

const app = express();
app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

app.get('/api/cosmetics/:uuid', (req, res) => {
    const uuid = req.params.uuid;
    if (!UUID_PATTERN.test(uuid)) {
        return res.status(400).json({ error: 'invalid uuid' });
    }

    const entry = data[uuid.toLowerCase()] || {};
    res.json({
        cape: entry.cape || 'none',
        hat: entry.hat || 'none',
        wings: entry.wings || 'none',
    });
});

app.post('/api/cosmetics/:uuid', (req, res) => {
    if (API_KEY && req.header('X-Api-Key') !== API_KEY) {
        return res.status(401).json({ error: 'missing or wrong X-Api-Key' });
    }

    const uuid = req.params.uuid;
    if (!UUID_PATTERN.test(uuid)) {
        return res.status(400).json({ error: 'invalid uuid' });
    }

    const { type, value } = req.body || {};
    const slot = typeof type === 'string' ? type.toUpperCase() : '';
    if (!VALID_IDS[slot]) {
        return res.status(400).json({ error: `unknown type "${type}", expected one of ${Object.keys(VALID_IDS).join(', ')}` });
    }
    if (!VALID_IDS[slot].includes(value)) {
        return res.status(400).json({ error: `unknown value "${value}" for ${slot}` });
    }

    const key = uuid.toLowerCase();
    const entry = data[key] || {};
    entry[slot.toLowerCase()] = value;
    data[key] = entry;
    writeData(data);

    res.json({ ok: true, uuid: key, [slot.toLowerCase()]: value });
});

app.listen(PORT, () => {
    if (!API_KEY) {
        console.warn('API_KEY is not set - anyone who can reach this server can write cosmetics for any UUID. Fine for local testing, set API_KEY before exposing this publicly.');
    }
    console.log(`mycosmetics backend listening on port ${PORT}`);
});
