// mycosmetics backend
//
// A deliberately tiny HTTP service: every instance of the mycosmetics Fabric
// mod (yours and everyone else's) calls this instead of going through the
// Minecraft server, so cosmetics can be visible to other players on ANY
// server - including ones that don't (and can't) have the mod installed.
//
// STORAGE: Upstash Redis (a free-tier, REST-based Redis) when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars are set,
// otherwise falls back to a local data.json file. The file fallback exists
// purely so this still runs with zero setup for local testing - it should
// NOT be relied on once deployed, because Render's free tier disk is
// ephemeral and gets wiped whenever the service sleeps/wakes (which is
// exactly why cosmetics were resetting after a Minecraft restart: it's
// not the client forgetting anything, it's the backend's disk getting
// wiped out from under it). Set the two Upstash env vars in Render and
// this automatically switches to the persistent path - nothing else
// changes.
//
// To set up Upstash (free): create an account at upstash.com, create a
// Redis database, copy the "REST URL" and "REST Token" from its dashboard,
// then set those as UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in
// Render's Environment tab and redeploy.
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

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PERSISTENT = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_KEY = 'mycosmetics:data'; // single key holding the whole {uuid: {...}} blob - plenty for a hobby player count

// Keep this in sync with CosmeticType#validIds() on the client - anything
// not in here is rejected instead of silently stored, so a typo'd/garbage
// value from a broken client can't end up rendered (or crash a renderer
// that assumes every id resolves to a known texture).
const VALID_IDS = {
    CAPE: ['none', 'sharingan', 'itachi', 'sasuke', 'money'],
    HAT: ['none', 'top_hat', 'party_hat'],
    WINGS: ['none', 'heaven', 'purple', 'dragon', 'devil', 'blue_dragon'],
};

// Status-line-above-the-nametag options. "platform" controls which small
// icon (if any) is shown; text/color/bold/italic/underline control the
// custom status text next to it.
const VALID_PLATFORMS = ['none', 'tiktok', 'twitch', 'youtube'];
const STATUS_TEXT_MAX_LENGTH = 32;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---- storage layer - either Upstash Redis (persistent) or a local file
// (NOT persistent on Render's free tier - see note above) ----

function readDataFromFile() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        console.error('Failed to read data file, starting from an empty store:', err);
        return {};
    }
}

function writeDataToFile(data) {
    // Synchronous + atomic-ish (write temp, rename) so a crash mid-write
    // can't leave data.json half-written/corrupted.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

async function upstashCommand(commandArray) {
    const res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commandArray),
    });
    const body = await res.json();
    if (!res.ok) {
        throw new Error(`Upstash error: ${JSON.stringify(body)}`);
    }
    return body.result;
}

// In-memory copy kept in sync with whichever backing store is active, so
// every request isn't a network round trip on top of the Upstash one - we
// still write through to Upstash immediately on every change, this is just
// a read cache for the common case of many GETs per POST.
let data = {};

async function loadInitialData() {
    if (PERSISTENT) {
        try {
            const raw = await upstashCommand(['GET', REDIS_KEY]);
            data = raw ? JSON.parse(raw) : {};
        } catch (err) {
            console.error('Failed to load initial data from Upstash, starting empty:', err);
            data = {};
        }
    } else {
        data = readDataFromFile();
    }
}

async function persist() {
    if (PERSISTENT) {
        await upstashCommand(['SET', REDIS_KEY, JSON.stringify(data)]);
    } else {
        writeDataToFile(data);
    }
}

const app = express();
app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, persistent: PERSISTENT });
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

app.post('/api/cosmetics/:uuid', async (req, res) => {
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

    try {
        await persist();
    } catch (err) {
        console.error('Failed to persist data:', err);
        return res.status(500).json({ error: 'failed to save' });
    }

    res.json({ ok: true, uuid: key, [slot.toLowerCase()]: value });
});

// ---- status line above the nametag ----

app.get('/api/status/:uuid', (req, res) => {
    const uuid = req.params.uuid;
    if (!UUID_PATTERN.test(uuid)) {
        return res.status(400).json({ error: 'invalid uuid' });
    }

    const entry = (data[uuid.toLowerCase()] || {}).status || {};
    res.json({
        platform: entry.platform || 'none',
        text: entry.text || '',
        color: entry.color || '#FFFFFF',
        bold: Boolean(entry.bold),
        italic: Boolean(entry.italic),
        underline: Boolean(entry.underline),
    });
});

app.post('/api/status/:uuid', async (req, res) => {
    if (API_KEY && req.header('X-Api-Key') !== API_KEY) {
        return res.status(401).json({ error: 'missing or wrong X-Api-Key' });
    }

    const uuid = req.params.uuid;
    if (!UUID_PATTERN.test(uuid)) {
        return res.status(400).json({ error: 'invalid uuid' });
    }

    const body = req.body || {};
    const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : 'none';
    if (!VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: `unknown platform "${body.platform}", expected one of ${VALID_PLATFORMS.join(', ')}` });
    }

    const text = typeof body.text === 'string' ? body.text.slice(0, STATUS_TEXT_MAX_LENGTH) : '';

    const color = typeof body.color === 'string' ? body.color : '#FFFFFF';
    if (!HEX_COLOR_PATTERN.test(color)) {
        return res.status(400).json({ error: `color must look like "#RRGGBB", got "${body.color}"` });
    }

    const status = {
        platform,
        text,
        color,
        bold: Boolean(body.bold),
        italic: Boolean(body.italic),
        underline: Boolean(body.underline),
    };

    const key = uuid.toLowerCase();
    const entry = data[key] || {};
    entry.status = status;
    data[key] = entry;

    try {
        await persist();
    } catch (err) {
        console.error('Failed to persist data:', err);
        return res.status(500).json({ error: 'failed to save' });
    }

    res.json({ ok: true, uuid: key, status });
});

loadInitialData().then(() => {
    app.listen(PORT, () => {
        if (!API_KEY) {
            console.warn('API_KEY is not set - anyone who can reach this server can write cosmetics for any UUID. Fine for local testing, set API_KEY before exposing this publicly.');
        }
        if (!PERSISTENT) {
            console.warn('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set - using local data.json, which will NOT survive this service sleeping/restarting on Render\'s free tier. Set those two env vars to fix that.');
        }
        console.log(`mycosmetics backend listening on port ${PORT} (persistent=${PERSISTENT})`);
    });
});
