'use strict';

/*
 * ioBroker Adapter für Feller zeptrion / zApp WLAN-Aktoren
 * (WLAN-Nebenstelle 4K = zApp-Gateway, WLAN-Zwischenmodul 2K = zApp-Booster)
 *
 * Basiert auf der zrap Webservice API, Dokument 10.ZEPAPI-E.1612 / Version 1.0
 *
 * Enthält:
 *  - Polling von Kanalzuständen (zrap/chscan) und Signalstärke (zrap/rssi)
 *  - Statische Geräteinfos (zrap/id), Netzwerkinfos (zrap/net), Kanalbeschreibungen (zrap/chdes)
 *  - Vollständige Kanalsteuerung (zrap/chctrl): on/off/stop/toggle/open/close/move_open/
 *    move_close/dim_up/dim_down inkl. timed-Varianten, sowie Szenen recall/store/delete
 *  - Systembefehle (zrap/sys): reboot / factory-default / network-default
 *  - Sammelbefehle für Hagelalarm: control.closeAllShutters / openAllShutters / stopAllShutters
 *  - mDNS-Discovery (Kapitel 4 der API-Doku) zum automatischen Auffinden von Geräten im Netz,
 *    Ergebnisse werden als deaktivierte Zeilen in die Konfigurationstabelle übernommen
 *    (kombiniert Auto-Erkennung mit manueller Kontrolle/Aktivierung durch den Anwender)
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

let Bonjour;
try {
    // optionale Abhängigkeit - Discovery wird ohne dieses Modul einfach übersprungen
    Bonjour = require('bonjour-service').Bonjour;
} catch (e) {
    Bonjour = null;
}

const xmlParser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    // WICHTIG: ohne diese beiden Optionen landet die XML-Deklaration (<?xml ...?>)
    // als eigener Key '?xml' im Ergebnis und Object.keys(parsed)[0] träfe die
    // Deklaration statt der Nutzdaten (Bug in 0.5.0: alle Werte blieben null).
    ignoreDeclaration: true,
    ignorePiTags: true,
    // Werte NICHT automatisch in Zahlen wandeln: chdes type/cat sind Codes wie
    // "0815", die als Zahl ihre führende Null verlieren würden. Numerische Felder
    // (val, dbm) werden gezielt per parseInt konvertiert.
    parseTagValue: false
});

// gültige einfache chctrl-Kommandos (Kapitel 3.6.3)
const SIMPLE_CMDS = [
    'stop', 'on', 'off', 'toggle',
    'dim_up', 'dim_down',
    'close', 'open',
    'move_close', 'move_open'
];
// Szenenbefehle 1-4 (Kapitel 3.6.3)
const SCENE_CMDS = [1, 2, 3, 4].flatMap(n => [`recall_s${n}`, `store_s${n}`, `delete_s${n}`]);
// zeitgesteuerte Varianten, t = 100-32000 ms (Kapitel 3.6.3)
const TIMED_CMD_RE = /^(dim_up|dim_down|move_open|move_close|dim)_(\d{3,5})$/;

function isValidChCmd(cmd) {
    if (SIMPLE_CMDS.includes(cmd) || SCENE_CMDS.includes(cmd)) return true;
    const m = String(cmd).match(TIMED_CMD_RE);
    if (m) {
        const t = parseInt(m[2], 10);
        return t >= 100 && t <= 32000;
    }
    return false;
}

const SYS_CMDS = {
    reboot: 'reboot',
    factoryDefault: 'factory-default',
    networkDefault: 'network-default'
};

// Zeitfenster nach einem gesendeten Bewegungsbefehl, in dem ein zeitgleicher
// chscan-Resync den Kanalwert nicht überschreibt (siehe sendChannelCommand).
const COMMAND_SETTLE_MS = 5000;
// Debounce-Fenster: mehrere Kanalbefehle desselben Geräts, die innerhalb dieser
// Zeit eintreffen (z.B. "alle Storen schliessen"), werden zu einem einzigen
// Multicast-POST an /zrap/chctrl gebündelt statt N sequentiellen Einzelrequests
// an den (schwachbrüstigen) Embedded-Webserver des Aktors.
const COMMAND_BATCH_MS = 50;
// Long-Poll-Timeout für zrap/chnotify: laut Doku antwortet das Gerät spätestens
// nach 30s auch ohne Änderung - Timeout grosszügig darüber ansetzen.
const NOTIFY_TIMEOUT_MS = 35000;
// Pause vor einem erneuten chnotify-Aufruf nach einem Fehler, um das Gerät/Netz
// bei anhaltenden Problemen nicht zuzuspammen.
const NOTIFY_ERROR_RETRY_MS = 10000;
// Grenzen der zeitgesteuerten chctrl-Befehle laut API (Kapitel 3.6.3).
const MIN_TIMED_MS = 100;
const MAX_TIMED_MS = 32000;
// Pause zwischen zwei gestückelten Fahr-Impulsen bei setPosition (Fahrten länger
// als MAX_TIMED_MS müssen in mehrere move_*_(t)-Impulse zerlegt werden).
const DRIVE_GAP_MS = 400;

const CH_BUTTONS = {
    stop: 'Stopp',
    on: 'Ein (100%)',
    off: 'Aus (0%)',
    toggle: 'Umschalten',
    open: 'Öffnen',
    close: 'Schliessen',
    move_open: 'Öffnen (Taste halten)',
    move_close: 'Schliessen (Taste halten)',
    dim_up: 'Dimmen hoch (Taste halten)',
    dim_down: 'Dimmen runter (Taste halten)'
};

class Zeptrion extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'zeptrion' });

        this.devices = {}; // id -> { cfg, client, timer, fails, connected }

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------------------------------------------------------- ready

    // Force-corrects a small set of known-bad object roles/names left over from before this fix.
    // Only touches an object if it still holds the exact old, known-bad value, so it never
    // clobbers anything a user might have customized in the meantime. Role fixes are matched by
    // ID suffix (calibrate/ntp.per are always per-device, unambiguous); the info.connection name
    // fix is matched by its exact old string value instead of by ID, since the adapter's own
    // built-in root "info.connection" object (not created by ensureState, must not be touched)
    // would otherwise be hard to tell apart from the per-device one by ID pattern alone.
    async migrateObjectRoles() {
        try {
            const objects = await this.getAdapterObjectsAsync();
            let fixedCount = 0;
            for (const id of Object.keys(objects)) {
                const obj = objects[id];
                if (!obj || obj.type !== 'state' || !obj.common) {
                    continue;
                }
                if (/\.calibrate$/.test(id) && (obj.common.role === 'value' || obj.common.read === false)) {
                    await this.extendObjectAsync(id, { common: { role: 'level', read: true } });
                    fixedCount++;
                } else if (/\.ntp\.per$/.test(id) && obj.common.role === 'value') {
                    await this.extendObjectAsync(id, { common: { role: 'level' } });
                    fixedCount++;
                } else if (/\.info\.connection$/.test(id) && obj.common.name === 'Verbindung OK') {
                    await this.extendObjectAsync(id, {
                        common: {
                            name: {
                                en: 'Connection OK',
                                de: 'Verbindung OK',
                                ru: 'Соединение в порядке',
                                pt: 'Ligação OK',
                                nl: 'Verbinding OK',
                                fr: 'Connexion OK',
                                it: 'Connessione OK',
                                es: 'Conexión OK',
                                pl: 'Połączenie OK',
                                uk: "З'єднання в порядку",
                                'zh-cn': '连接正常'
                            }
                        }
                    });
                    fixedCount++;
                }
            }
            if (fixedCount > 0) {
                this.log.info(`Migration: corrected role/name on ${fixedCount} existing object(s) created by an older version.`);
            }
        } catch (e) {
            // Never let a migration failure block adapter startup.
            this.log.warn(`Migration of object roles/names failed (non-fatal, adapter will continue starting): ${e}`);
        }
    }

    async onReady() {
        // One-time (cheap-and-idempotent-every-startup) fix for role/name mistakes present in
        // objects created before this fix (see CHANGELOG). ensureState()/setObjectNotExistsAsync()
        // never touches an object that already exists, so simply updating the adapter does not
        // correct objects an already-running installation had already created - this actively
        // force-corrects them via extendObjectAsync() instead.
        await this.migrateObjectRoles();

        await this.setStateAsync('info.connection', { val: false, ack: true });

        const timeout = parseInt(String(this.config.requestTimeout), 10) || 4000;
        this.requestTimeout = Math.min(Math.max(timeout, 500), 30000);

        const devicesCfg = Array.isArray(this.config.devices) ? this.config.devices : [];

        // Auto-ID: Zeilen mit Host aber ohne ID bekommen eine aus dem Host abgeleitete
        // ID (z.B. "10.195.36.116" -> "zapp_10_195_36_116", "zapp-14150003.local" ->
        // "zapp_14150003"). Änderung wird einmalig in die Konfiguration zurück-
        // geschrieben (Adapter startet dadurch neu - passiert nur bei Änderungen).
        let cfgChanged = false;
        const usedIds = new Set(devicesCfg.map(d => d && d.id).filter(Boolean));
        for (const d of devicesCfg) {
            if (d && d.host && !d.id) {
                let base = String(d.host).trim().replace(/\.local\.?$/i, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
                if (/^\d/.test(base)) base = 'zapp_' + base;
                let candidate = base || 'device';
                let i = 2;
                while (usedIds.has(candidate)) candidate = `${base}_${i++}`;
                d.id = candidate;
                usedIds.add(candidate);
                if (!d.name) d.name = d.host;
                cfgChanged = true;
                this.log.info(`Geräte-ID automatisch vergeben: "${candidate}" für Host ${d.host}`);
            }
        }
        if (cfgChanged) {
            const instObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (instObj) {
                instObj.native.devices = devicesCfg;
                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
                return; // Adapter startet durch die Konfig-Änderung neu
            }
        }

        const active = devicesCfg.filter(d => d && d.enabled !== false && d.id && d.host);

        // --- Startup-Validierung aller manuell/per Import erfassten Zeilen ---
        // Ungültige Zeilen werden übersprungen (mit klarer Log-Meldung), nicht nur
        // stillschweigend falsch verarbeitet. Duplikate (ID oder Host doppelt, auch
        // nach Sanitisierung) würden sich sonst gegenseitig im Geräte-Registry
        // überschreiben und Geisterzustände hinterlassen.
        const seenIds = new Set();
        const seenHosts = new Set();
        const validated = [];
        for (const d of active) {
            const errs = this.validateDeviceRow(d);
            const sanId = this.sanitize(d.id);
            if (seenIds.has(sanId)) errs.push(`ID "${d.id}" (sanitisiert "${sanId}") ist doppelt vergeben`);
            const hostKey = String(d.host).trim().toLowerCase();
            if (seenHosts.has(hostKey)) errs.push(`Host "${d.host}" ist doppelt konfiguriert`);
            if (errs.length) {
                this.log.error(`Gerät "${d.name || d.id || d.host}" übersprungen: ${errs.join('; ')}`);
                continue;
            }
            seenIds.add(sanId);
            seenHosts.add(hostKey);
            validated.push(d);
        }

        if (!validated.length && active.length) {
            this.log.error('Alle konfigurierten Geräte sind ungültig - bitte Konfiguration prüfen (Test-Button verwenden).');
        }

        // --- Paralleles Setup ---
        // Sequentielles await würde bei vielen (teils offline) Geräten den Start
        // minutenlang blockieren (jedes Gerät macht mehrere HTTP-Calls mit Timeout).
        await Promise.allSettled(validated.map(async (dev) => {
            try {
                await this.setupDevice(dev);
            } catch (err) {
                this.log.error(`Gerät ${dev.id} konnte nicht initialisiert werden: ${err.message || err}`);
            }
        }));

        // Verwaiste Geräte-Objekte entfernen: alles unter zeptrion.N.<deviceId>, dessen
        // <deviceId> nicht (mehr) in der aktiven Konfiguration steht, wird gelöscht.
        // Verhindert, dass States gelöschter/umbenannter Geräte im Objektbaum liegen
        // bleiben (Bug: alte Zustände blieben nach Entfernen/Ersetzen eines Geräts).
        await this.cleanupOrphanedDevices(validated);

        if (!active.length) {
            this.log.warn('Keine aktiven zeptrion Geräte konfiguriert. Bitte in der Instanz-Konfiguration Geräte anlegen oder Discovery-Button verwenden.');
        }

        await this.createGlobalControlObjects();

        this.subscribeStates('*');
        this.updateGlobalConnection();
    }

    /**
     * Löscht Objektbäume von Geräten, die nicht mehr in der aktiven Konfiguration
     * stehen. getAdapterObjects liefert nur die Objekte dieser Instanz; daraus die
     * Top-Level-Geräte-IDs ableiten und gegen die konfigurierten IDs abgleichen.
     * Reservierte Top-Level-Knoten (info, control) werden nie angetastet.
     */
    async cleanupOrphanedDevices(validated) {
        const keepIds = new Set(validated.map(d => this.sanitize(d.id)));
        const reserved = new Set(['info', 'control']);
        try {
            const all = await this.getAdapterObjectsAsync();
            const prefix = `${this.namespace}.`;
            const deviceIds = new Set();
            for (const fullId of Object.keys(all)) {
                if (!fullId.startsWith(prefix)) continue;
                const top = fullId.substring(prefix.length).split('.')[0];
                if (top && !reserved.has(top)) deviceIds.add(top);
            }
            for (const devId of deviceIds) {
                if (!keepIds.has(devId)) {
                    this.log.info(`Entferne verwaistes Gerät "${devId}" (nicht mehr in der Konfiguration).`);
                    await this.delObjectAsync(devId, { recursive: true });
                }
            }
        } catch (err) {
            this.log.warn(`Aufräumen verwaister Objekte fehlgeschlagen: ${err.message || err}`);
        }
    }

    /** Validiert eine Geräte-Zeile aus der Konfiguration/dem CSV-Import. Gibt eine
     * Liste menschenlesbarer Fehler zurück (leer = gültig). */
    validateDeviceRow(d) {
        const errs = [];
        const host = String(d.host || '').trim();
        if (!host) {
            errs.push('Host fehlt');
        } else if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
            errs.push(`Host "${host}" enthält ungültige Zeichen (kein http://, keine Leerzeichen, kein Port)`);
        } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const octets = host.split('.').map(Number);
            if (octets.length !== 4 || octets.some(o => o < 0 || o > 255)) {
                errs.push(`"${host}" ist keine gültige IPv4-Adresse`);
            }
        }
        if (d.id && !/^[a-zA-Z0-9_-]+$/.test(String(d.id))) {
            errs.push(`ID "${d.id}" enthält ungültige Zeichen (erlaubt: a-z, 0-9, _, -)`);
        }
        const ch = parseInt(d.channels, 10);
        if (d.channels !== undefined && d.channels !== '' && (isNaN(ch) || ch < 1 || ch > 4)) {
            errs.push(`Kanäle "${d.channels}" ungültig (1-4)`);
        }
        if (d.kind !== undefined && d.kind !== '' && !['unknown', 'blind', 'light'].includes(String(d.kind))) {
            errs.push(`Art "${d.kind}" ungültig (unknown/blind/light)`);
        }
        const tt = parseInt(d.travelTimeSec, 10);
        if (d.travelTimeSec !== undefined && d.travelTimeSec !== '' && (isNaN(tt) || tt < 0 || tt > 300)) {
            errs.push(`Laufzeit "${d.travelTimeSec}" ungültig (0-300s)`);
        }
        if (d.travelTimeSecCh !== undefined && String(d.travelTimeSecCh).trim() !== '') {
            const parts = String(d.travelTimeSecCh).split(',').map(s => s.trim());
            if (parts.length > 4) {
                errs.push(`Laufzeit/Kanal "${d.travelTimeSecCh}": maximal 4 Werte`);
            }
            for (const p of parts) {
                if (p === '') continue; // leerer Eintrag = Fallback auf travelTimeSec
                const v = parseInt(p, 10);
                if (isNaN(v) || v < 0 || v > 300 || String(v) !== p) {
                    errs.push(`Laufzeit/Kanal "${d.travelTimeSecCh}": Wert "${p}" ungültig (0-300, ganzzahlig)`);
                    break;
                }
            }
        }
        const tp = parseInt(d.tiltTimeMs, 10);
        if (d.tiltTimeMs !== undefined && d.tiltTimeMs !== '' && (isNaN(tp) || tp < 0 || tp > 5000)) {
            errs.push(`Kipp-Impuls "${d.tiltTimeMs}" ungültig (0-5000ms)`);
        }
        const pi = parseInt(d.pollInterval, 10);
        if (d.pollInterval !== undefined && d.pollInterval !== '' && (isNaN(pi) || pi < 5 || pi > 3600)) {
            errs.push(`Poll-Intervall "${d.pollInterval}" ungültig (5-3600s)`);
        }
        return errs;
    }

    sanitize(str) {
        return String(str || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) || 'device';
    }

    async ensureState(idPath, common) {
        await this.setObjectNotExistsAsync(idPath, {
            type: 'state',
            common,
            native: {}
        });
    }

    async createGlobalControlObjects() {
        await this.setObjectNotExistsAsync('control', {
            type: 'channel',
            common: { name: 'Sammelbefehle' },
            native: {}
        });
        await this.ensureState('control.closeAllShutters', {
            name: 'ALLE Storen schliessen (z.B. Hagelalarm)',
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState('control.openAllShutters', {
            name: 'Alle Storen öffnen',
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState('control.stopAllShutters', {
            name: 'Alle Storen stoppen',
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
    }

    // ------------------------------------------------------- Geräte-Setup

    async setupDevice(devCfg) {
        const id = this.sanitize(devCfg.id);
        const channels = Math.min(Math.max(parseInt(devCfg.channels, 10) || 1, 1), 4);
        const pollInterval = Math.max(parseInt(devCfg.pollInterval, 10) || 30, 5) * 1000;
        const host = String(devCfg.host).trim();
        const travelTimeMs = Math.max(parseInt(devCfg.travelTimeSec, 10) || 0, 0) * 1000;
        const travelOverrides = String(devCfg.travelTimeSecCh || '').split(',').map(s => s.trim());
        const travelTimeMsByCh = {};
        for (let n = 1; n <= channels; n++) {
            const raw = travelOverrides[n - 1];
            const sec = (raw !== undefined && raw !== '') ? parseInt(raw, 10) : NaN;
            travelTimeMsByCh[n] = (!isNaN(sec) && sec >= 0) ? sec * 1000 : travelTimeMs;
        }
        const tiltTimeMs = Math.max(parseInt(devCfg.tiltTimeMs, 10) || 0, 0);
        const smartfront = devCfg.smartfront === true;

        if (!host) {
            this.log.warn(`Gerät ${id}: kein Host angegeben, wird übersprungen.`);
            return;
        }

        const client = axios.create({
            baseURL: `http://${host}`,
            timeout: this.requestTimeout,
            maxRedirects: 0,
            validateStatus: status => status < 400
        });

        this.devices[id] = {
            cfg: { id, name: devCfg.name || id, host, channels, pollInterval, kind: devCfg.kind || 'unknown', travelTimeMs, travelTimeMsByCh, tiltTimeMs, smartfront },
            client,
            timer: null,
            notifyActive: false,
            channelBusyUntil: {},
            posEstimate: {},   // chNum -> 0-100 (Software-Schätzung, siehe updatePositionEstimate)
            moveState: {},     // chNum -> {dir, startTs, startPos} während einer laufenden move_open/move_close-Fahrt
            driveToken: {},    // chNum -> Symbol der aktuell laufenden setPosition-Sequenz (Abbruch-Mechanismus)
            pendingCmds: {},   // chNum -> cmd, wird gebündelt und nach COMMAND_BATCH_MS als Multicast-POST gesendet
            pendingCallbacks: [],
            pendingTimer: null,
            fails: 0,
            connected: false
        };

        await this.createDeviceObjects(id, channels);
        await this.refreshStaticInfo(id);
        this.startPolling(id);
        if (this.config.useNotify !== false) {
            this.startNotifyLoop(id);
        } else {
            this.log.info(`[${id}] chnotify-Long-Poll per Konfiguration deaktiviert, nur Intervall-Polling aktiv.`);
        }
    }

    async createDeviceObjects(id, channelCount) {
        const dev = this.devices[id];

        await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: { name: dev.cfg.name, icon: '/adapter/zeptrion/zeptrion.png' },
            native: { host: dev.cfg.host, channels: dev.cfg.channels, kind: dev.cfg.kind, pollInterval: dev.cfg.pollInterval }
        });

        // --- info ---
        await this.setObjectNotExistsAsync(`${id}.info`, { type: 'channel', common: { name: 'Geräteinformationen' }, native: {} });
        await this.ensureState(`${id}.info.connection`, {
            name: {
                en: 'Connection OK',
                de: 'Verbindung OK',
                ru: 'Соединение в порядке',
                pt: 'Ligação OK',
                nl: 'Verbinding OK',
                fr: 'Connexion OK',
                it: 'Connessione OK',
                es: 'Conexión OK',
                pl: 'Połączenie OK',
                uk: "З'єднання в порядку",
                'zh-cn': '连接正常'
            },
            type: 'boolean', role: 'indicator.reachable', read: true, write: false, def: false
        });
        await this.ensureState(`${id}.info.lastError`, { name: 'Letzter Fehler', type: 'string', role: 'text', read: true, write: false, def: '' });
        await this.ensureState(`${id}.info.hw`, { name: 'Hardware-Version', type: 'string', role: 'info.hardware', read: true, write: false });
        await this.ensureState(`${id}.info.sw`, { name: 'Software-Version', type: 'string', role: 'info.firmware', read: true, write: false });
        await this.ensureState(`${id}.info.boot`, { name: 'Bootloader-Version', type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.sn`, { name: 'Seriennummer', type: 'string', role: 'info.serial', read: true, write: false });
        await this.ensureState(`${id}.info.sys`, { name: 'System-Name', type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.type`, { name: 'Gerätetyp (Device ID)', type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.oen`, { name: 'Owner Environment', type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.rssi`, { name: 'Signalstärke', type: 'number', role: 'value', unit: 'dBm', read: true, write: false });
        await this.ensureState(`${id}.info.refresh`, { name: 'Statische Infos neu laden (id/net/chdes)', type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- network (read-only Anzeige, siehe README für Gründe) ---
        await this.setObjectNotExistsAsync(`${id}.network`, { type: 'channel', common: { name: 'Netzwerk' }, native: {} });
        const netFields = {
            ssid: 'SSID', ip: 'IP-Adresse', mac: 'MAC-Adresse',
            mode: 'Netzwerkmodus (0=AccessPoint, 1=Associate)', enc: 'Verschlüsselung',
            mask: 'Subnetzmaske', gw: 'Gateway', bssid: 'MAC-Adresse Access Point'
        };
        for (const [key, name] of Object.entries(netFields)) {
            await this.ensureState(`${id}.network.${key}`, { name, type: 'string', role: 'text', read: true, write: false });
        }

        // --- system ---
        await this.setObjectNotExistsAsync(`${id}.system`, { type: 'channel', common: { name: 'Systembefehle' }, native: {} });
        await this.ensureState(`${id}.system.reboot`, { name: 'Neustart', type: 'boolean', role: 'button', read: false, write: true, def: false });
        await this.ensureState(`${id}.system.unlock`, {
            name: 'Entriegelung für Werksreset (Sicherheitsverriegelung: muss max. 30s VOR factoryDefault auf true gesetzt werden)',
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState(`${id}.system.factoryDefault`, { name: 'ACHTUNG: Werksreset - löscht ALLE Einstellungen inkl. WLAN, Gerät fällt vom Netz! Erfordert vorheriges system.unlock (30s-Fenster)', type: 'boolean', role: 'button', read: false, write: true, def: false });
        await this.ensureState(`${id}.system.networkDefault`, { name: 'Zurück in Access-Point-Modus (Konfiguration bleibt erhalten)', type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- location (zrap/loc) ---
        await this.setObjectNotExistsAsync(`${id}.location`, { type: 'channel', common: { name: 'Standort' }, native: {} });
        await this.ensureState(`${id}.location.name`, { name: 'Standortbezeichnung (frei wählbar, z.B. "Fideris Valzigg")', type: 'string', role: 'text', read: true, write: true });

        // --- ntp (zrap/ntp) ---
        await this.setObjectNotExistsAsync(`${id}.ntp`, { type: 'channel', common: { name: 'NTP' }, native: {} });
        await this.ensureState(`${id}.ntp.url`, { name: 'NTP-Server (URL/IP, max. 32 Zeichen)', type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.ntp.per`, { name: 'Abfrageintervall in Stunden (0=deaktiviert)', type: 'number', role: 'level', read: true, write: true, min: 0, max: 255 });

        // --- date (zrap/date) ---
        await this.setObjectNotExistsAsync(`${id}.date`, { type: 'channel', common: { name: 'Datum/Zeit' }, native: {} });
        await this.ensureState(`${id}.date.rfc1123`, { name: 'RFC1123 Zeitstempel (muss GMT sein)', type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.tz`, { name: 'Zeitzonen-Offset HHMM (z.B. +0200)', type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.dst`, { name: 'Sommerzeit-Offset HHMM', type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.syncNow`, { name: 'Button: Geräte-Uhrzeit mit ioBroker-Host synchronisieren', type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- smartfront (zapi, optional - nur bei angeschlossenem Smartfront-Taster) ---
        if (dev.cfg.smartfront) {
            await this.setObjectNotExistsAsync(`${id}.smartfront`, { type: 'channel', common: { name: 'Smartfront' }, native: {} });
            await this.ensureState(`${id}.smartfront.temp`, { name: 'Temperatur', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false });
            await this.ensureState(`${id}.smartfront.lux`, { name: 'Helligkeit', type: 'number', role: 'value.brightness', unit: 'lx', read: true, write: false });
            await this.ensureState(`${id}.smartfront.hum`, { name: 'Luftfeuchtigkeit', type: 'number', role: 'value.humidity', unit: '%', read: true, write: false });
            await this.ensureState(`${id}.smartfront.ledState`, { name: 'Aktueller LED-Status (JSON, read-only)', type: 'string', role: 'json', read: true, write: false });
            await this.ensureState(`${id}.smartfront.ledSet`, {
                name: 'LED(s) setzen - JSON-Array wie in API-Doku 5.1.3.4, z.B. [{"id":2,"bg":"#220000"}]. Laut Doku nur "bg" (Hintergrundfarbe) unbedenklich extern setzbar.',
                type: 'string', role: 'json', read: false, write: true, def: ''
            });
        }

        // --- channels ---
        // Rollen richten sich nach dem optionalen "kind"-Feld pro Gerät (Storen/Licht/
        // unbekannt). Bei "unbekannt" bleibt es bei den bisherigen generischen Rollen,
        // da die zrap-API selbst nicht zwischen Licht- und Storenkanal unterscheidet
        // (chscan liefert für einen Storenkanal laut Doku i.d.R. ohnehin -1 = unbekannt -
        // "level.blind" ist damit ein Angebot für VIS-Widget-Kompatibilität, liefert aber
        // ohne echte Positionsrückmeldung der Hardware keinen laufend aktuellen Wert).
        const kind = dev.cfg.kind;
        // .val bleibt bewusst neutral ("value") - das ist der ROHE Hardwarewert und
        // bei Storen laut Doku praktisch immer -1. Die Rolle "level.blind" (für VIS-
        // Widgets) sitzt stattdessen auf der Software-Positionsschätzung unten.
        const valRole = kind === 'light' ? 'level.dimmer' : 'value';
        const btnRoles = kind === 'blind'
            ? { stop: 'button.stop', open: 'button.open.blind', close: 'button.close.blind' }
            : {};

        await this.setObjectNotExistsAsync(`${id}.channels`, { type: 'channel', common: { name: 'Kanäle' }, native: {} });
        for (let n = 1; n <= channelCount; n++) {
            const ch = `${id}.channels.ch${n}`;
            await this.setObjectNotExistsAsync(ch, {
                type: 'channel',
                common: { name: `Kanal ${n}` },
                native: { channelNumber: n, host: dev.cfg.host, kind }
            });

            await this.ensureState(`${ch}.val`, {
                name: 'Zustand (0-100, bei Storen meist -1=unbekannt)',
                type: 'number', role: valRole, min: -1, max: 100, read: true, write: false
            });

            if (kind === 'blind') {
                const hasTravel = !!dev.cfg.travelTimeMsByCh[n];
                // extendObject statt setObjectNotExists: Beschreibung und Semantik
                // hängen von der Konfiguration ab und sollen sich mit aktualisieren.
                await this.extendObjectAsync(`${ch}.posEstimate`, {
                    type: 'state',
                    common: {
                        name: hasTravel
                            ? 'Geschätzte Ist-Position 0=zu/100=offen (reine Anzeige der Software-Schätzung, KEINE Hardware-Rückmeldung; zum Kalibrieren "calibrate" verwenden, zum Anfahren "setPosition")'
                            : 'Geschätzte Position (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)',
                        type: 'number', role: 'value.blind', min: 0, max: 100, read: true, write: false
                    },
                    native: {}
                });
                await this.extendObjectAsync(`${ch}.setPosition`, {
                    type: 'state',
                    common: {
                        name: hasTravel
                            ? 'Position anfahren 0=zu/100=offen (zeitbasiert über move-Impulse; 0/100 fahren als echte Endlagenfahrt und rekalibrieren die Schätzung)'
                            : 'Position anfahren (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)',
                        type: 'number', role: 'level.blind', min: 0, max: 100, read: true, write: true
                    },
                    native: {}
                });
                await this.ensureState(`${ch}.calibrate`, {
                    name: 'Schätzung setzen OHNE Fahrt (z.B. nach manueller Bedienung am Wandtaster): aktuellen Ist-Zustand in % eintragen',
                    type: 'number', role: 'level', min: 0, max: 100, read: true, write: true
                });
                await this.extendObjectAsync(`${ch}.tiltOpen`, {
                    type: 'state',
                    common: {
                        name: dev.cfg.tiltTimeMs
                            ? `Lamellen kippen Richtung offen (Impuls ${dev.cfg.tiltTimeMs}ms)`
                            : 'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)',
                        type: 'boolean', role: 'button', read: false, write: true, def: false
                    },
                    native: {}
                });
                await this.extendObjectAsync(`${ch}.tiltClose`, {
                    type: 'state',
                    common: {
                        name: dev.cfg.tiltTimeMs
                            ? `Lamellen kippen Richtung zu (Impuls ${dev.cfg.tiltTimeMs}ms)`
                            : 'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)',
                        type: 'boolean', role: 'button', read: false, write: true, def: false
                    },
                    native: {}
                });
            }

            await this.ensureState(`${ch}.name`, { name: 'Kanalname (chdes)', type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.group`, { name: 'Gruppe (chdes)', type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.icon`, { name: 'Icon (chdes)', type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.type`, { name: 'Typ-Code (chdes)', type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.cat`, { name: 'Kategorie-Code (chdes)', type: 'string', role: 'text', read: true, write: true });

            await this.ensureState(`${ch}.command`, {
                name: 'Freier Befehl (z.B. dim_2000, move_close_5000, recall_s1 …)',
                type: 'string', role: 'text', read: false, write: true, def: ''
            });

            for (const [cmd, name] of Object.entries(CH_BUTTONS)) {
                await this.ensureState(`${ch}.${cmd}`, {
                    name, type: 'boolean', role: btnRoles[cmd] || 'button', read: false, write: true, def: false
                });
            }
            for (let s = 1; s <= 4; s++) {
                await this.ensureState(`${ch}.recall_s${s}`, { name: `Szene ${s} abrufen`, type: 'boolean', role: 'button', read: false, write: true, def: false });
                await this.ensureState(`${ch}.store_s${s}`, { name: `Szene ${s} speichern`, type: 'boolean', role: 'button', read: false, write: true, def: false });
                await this.ensureState(`${ch}.delete_s${s}`, { name: `Szene ${s} löschen`, type: 'boolean', role: 'button', read: false, write: true, def: false });
            }
        }
    }

    // ------------------------------------------------------------- HTTP-IO

    async zrapGet(id, path, axiosOpts = {}) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unbekanntes Gerät ${id}`);
        const res = await dev.client.get(path, { responseType: 'text', transformResponse: [d => d], ...axiosOpts });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        if (!res.data) return {};
        const parsed = xmlParser.parse(res.data);
        // Root-Element robust wählen: Keys, die mit '?' beginnen (XML-Deklaration,
        // Processing Instructions), überspringen - zweite Verteidigungslinie zur
        // Parser-Option ignoreDeclaration.
        const rootKey = Object.keys(parsed).find(k => !k.startsWith('?'));
        return (rootKey && parsed[rootKey]) || {};
    }

    async zrapPost(id, path, bodyObj) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unbekanntes Gerät ${id}`);
        const data = Object.entries(bodyObj)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
        const res = await dev.client.post(path, data, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res;
    }

    // zapi (Kapitel 5) ist JSON-basiert, im Gegensatz zu zrap (XML/urlencoded).
    // Nur relevant für Geräte mit angeschlossenem Smartfront (WLAN-Zwischenmodul-2k
    // 3340-2-B + Front 920-330x), daher separat und optional (Konfig-Checkbox).
    async zapiGet(id, path) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unbekanntes Gerät ${id}`);
        const res = await dev.client.get(path);
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res.data;
    }

    async zapiPost(id, path, jsonBody) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unbekanntes Gerät ${id}`);
        const res = await dev.client.post(path, jsonBody, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res;
    }

    /** Extrahiert die erste Fliesskommazahl aus einem zapi-Sensorwert wie "24.50C" oder "none". */
    parseSensorNumber(str) {
        if (typeof str !== 'string') return null;
        const m = str.match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
    }

    /**
     * Prüft String-Werte gegen die Byte-Limits der zrap-API (UTF-8-Bytes, nicht
     * Zeichen! Ein Umlaut = 2 Bytes, siehe Fussnoten in Kapitel 3.7/3.12 der Doku).
     * Wirft eine klare Fehlermeldung statt eines nichtssagenden HTTP-400 vom Gerät.
     */
    validateApiString(value, maxBytes, fieldName) {
        const str = String(value ?? '');
        const bytes = Buffer.byteLength(str, 'utf8');
        if (bytes > maxBytes) {
            throw new Error(`${fieldName}: ${bytes} Bytes überschreiten das API-Limit von ${maxBytes} Bytes (Achtung: Umlaute zählen als 2 Bytes)`);
        }
        return str;
    }

    /**
     * Reiht einen Kanalbefehl in die Sende-Queue des Geräts ein. Mehrere Befehle
     * desselben Geräts, die innerhalb von COMMAND_BATCH_MS eintreffen, werden zu
     * einem einzigen Multicast-POST an /zrap/chctrl gebündelt (Kapitel 3.6.5).
     * Das Promise löst erst auf, wenn der gebündelte Request tatsächlich raus ist.
     */
    sendChannelCommand(id, chNum, cmd) {
        if (!isValidChCmd(cmd)) {
            return Promise.reject(new Error(`Ungültiger Kanalbefehl "${cmd}"`));
        }
        const dev = this.devices[id];
        if (!dev) return Promise.reject(new Error(`Unbekanntes Gerät ${id}`));

        return new Promise((resolve, reject) => {
            dev.pendingCmds[chNum] = cmd;
            dev.pendingCallbacks.push({ resolve, reject });
            if (!dev.pendingTimer) {
                dev.pendingTimer = this.setTimeout(() => this.flushPendingCmds(id), COMMAND_BATCH_MS);
            }
        });
    }

    async flushPendingCmds(id) {
        const dev = this.devices[id];
        if (!dev) return;
        const cmds = dev.pendingCmds;
        const callbacks = dev.pendingCallbacks;
        dev.pendingCmds = {};
        dev.pendingCallbacks = [];
        dev.pendingTimer = null;

        const chNums = Object.keys(cmds);
        if (!chNums.length) return;

        try {
            if (chNums.length === 1) {
                const chNum = chNums[0];
                await this.zrapPost(id, `/zrap/chctrl/ch${chNum}`, { cmd: cmds[chNum] });
                this.log.info(`[${id}] Kanalbefehl gesendet: ch${chNum} -> ${cmds[chNum]}`);
            } else {
                const body = {};
                for (const chNum of chNums) body[`cmd${chNum}`] = cmds[chNum];
                await this.zrapPost(id, '/zrap/chctrl', body);
                const summary = chNums.map(n => `ch${n}->${cmds[n]}`).join(', ');
                this.log.info(`[${id}] Multicast-Befehl gesendet: ${summary}`);
                this.log.debug(`[${id}] Multicast-Befehl gebündelt: ${JSON.stringify(body)}`);
            }
            for (const chNum of chNums) {
                this.markChannelBusy(dev, chNum, cmds[chNum]);
                this.updatePositionEstimate(id, parseInt(chNum, 10), cmds[chNum]).catch(() => {});
            }
            callbacks.forEach(cb => cb.resolve());
        } catch (err) {
            const summary = chNums.map(n => `ch${n}->${cmds[n]}`).join(', ');
            this.log.warn(`[${id}] Kanalbefehl fehlgeschlagen (${summary}): ${err.message || err}`);
            callbacks.forEach(cb => cb.reject(err));
        }
    }

    /** Sicherheitsnetz gegen Race Conditions mit dem periodischen chscan-Resync
     * (reine Lese-/Verwaltungsbefehle wie store/delete Szene bewegen nichts). */
    markChannelBusy(dev, chNum, cmd) {
        if (!/^(store_s|delete_s)/.test(cmd)) {
            dev.channelBusyUntil[chNum] = Date.now() + COMMAND_SETTLE_MS;
        }
    }

    /**
     * Best-Effort-Positionsschätzung für Storenkanäle (siehe README "Positions-
     * schätzung"). Die Hardware selbst liefert laut Feller-Doku für Storen nahezu
     * immer -1 (unbekannt) - diese Schätzung basiert rein auf Bewegungsrichtung und
     * verstrichener Zeit relativ zur konfigurierten Gesamtlaufzeit. Nur aktiv, wenn
     * kind === 'blind' und eine Laufzeit (travelTimeMs) konfiguriert ist.
     */
    async updatePositionEstimate(id, chNum, cmd) {
        const dev = this.devices[id];
        if (!dev || dev.cfg.kind !== 'blind' || !dev.cfg.travelTimeMsByCh[chNum]) return;
        const travel = dev.cfg.travelTimeMsByCh[chNum];
        const now = Date.now();
        const cur = dev.posEstimate[chNum];

        const setEstimate = async (val) => {
            dev.posEstimate[chNum] = Math.max(0, Math.min(100, Math.round(val)));
            await this.setStateAsync(`${id}.channels.ch${chNum}.posEstimate`, { val: dev.posEstimate[chNum], ack: true });
        };

        if (cmd === 'open' || cmd === 'close') {
            // "open"/"close" fahren selbstständig bis zur Endlage. Die Fahrt wird
            // trotzdem als moveState getrackt: ein "stop" mittendrin kann so die
            // Zwischenposition berechnen, und der Endlagen-Timer feuert dann NICHT
            // mehr fälschlich (moveState wurde durch stop genullt).
            const dir = cmd === 'open' ? 'open' : 'close';
            const target = cmd === 'open' ? 100 : 0;
            const startTs = now;
            dev.moveState[chNum] = { dir, startTs, startPos: cur ?? (dir === 'open' ? 0 : 100) };
            this.setTimeout(() => {
                if (!this.devices[id]) return;
                const mv = dev.moveState[chNum];
                if (!mv || mv.startTs !== startTs) return; // gestoppt oder neuer Befehl
                dev.moveState[chNum] = null;
                setEstimate(target).catch(() => {});
            }, travel);
        } else if (cmd === 'move_open' || cmd === 'move_close') {
            dev.moveState[chNum] = {
                dir: cmd === 'move_open' ? 'open' : 'close',
                startTs: now,
                startPos: cur ?? (cmd === 'move_open' ? 0 : 100)
            };
        } else if (cmd === 'stop') {
            const mv = dev.moveState[chNum];
            if (mv) {
                const fraction = Math.min((now - mv.startTs) / travel, 1);
                const val = mv.dir === 'open'
                    ? mv.startPos + fraction * (100 - mv.startPos)
                    : mv.startPos - fraction * mv.startPos;
                dev.moveState[chNum] = null;
                await setEstimate(val);
            }
        } else {
            const m = cmd.match(/^(move_open|move_close)_(\d{3,5})$/);
            if (m) {
                const dir = m[1] === 'move_open' ? 'open' : 'close';
                const t = parseInt(m[2], 10);
                const startPos = cur ?? (dir === 'open' ? 0 : 100);
                const startTs = now;
                dev.moveState[chNum] = { dir, startTs, startPos };
                this.setTimeout(() => {
                    if (!this.devices[id]) return;
                    const mv = dev.moveState[chNum];
                    if (!mv || mv.startTs !== startTs) return; // durch neueren Befehl überschrieben
                    const fraction = Math.min(t / travel, 1);
                    const val = dir === 'open' ? startPos + fraction * (100 - startPos) : startPos - fraction * startPos;
                    dev.moveState[chNum] = null;
                    setEstimate(val).catch(() => {});
                }, t);
            }
            // recall_sN, on/off/toggle, dim_*, store/delete: keine Schätzung möglich,
            // Position bleibt unverändert.
        }
    }

    /** Bricht eine laufende setPosition-Sequenz für diesen Kanal ab (z.B. weil ein
     * manueller Befehl oder ein neues setPosition eingetroffen ist). */
    cancelDrive(id, chNum) {
        const dev = this.devices[id];
        if (dev && dev.driveToken[chNum]) {
            dev.driveToken[chNum] = null;
        }
    }

    /**
     * Fährt einen Storenkanal zeitbasiert auf eine Zielposition (0=zu, 100=offen).
     *
     * WICHTIG - Grenzen dieses Verfahrens (siehe README):
     * Die Hardware meldet KEINE Position zurück (chscan liefert für Storen immer -1).
     * Die Anfahrt basiert vollständig auf der Software-Schätzung + konfigurierter
     * Motor-Laufzeit und driftet über die Zeit (Anlaufverzögerung, Temperatur, Last).
     * Selbstkorrektur: Ziel 0/100 wird als echte Endlagenfahrt (cmd close/open)
     * ausgeführt und rekalibriert die Schätzung; ohne bekannte Ausgangsposition wird
     * zuerst eine Referenzfahrt zur näheren Endlage gemacht.
     *
     * Das API-Limit von 32s pro move_*_(t)-Impuls wird durch Stückelung in mehrere
     * sequentielle Impulse umgangen (relevant bei Laufzeiten > ~64s).
     */
    async driveToPosition(id, chNum, target) {
        const dev = this.devices[id];
        if (!dev) return;
        if (dev.cfg.kind !== 'blind' || !dev.cfg.travelTimeMsByCh[chNum]) {
            throw new Error('setPosition erfordert Art=Storen und eine konfigurierte Motor-Laufzeit (>0s) für diesen Kanal');
        }
        target = Math.max(0, Math.min(100, Math.round(Number(target))));
        const travel = dev.cfg.travelTimeMsByCh[chNum];

        // laufende Sequenz dieses Kanals abbrechen, eigenes Token registrieren
        const token = Symbol('drive');
        dev.driveToken[chNum] = token;
        const aborted = () => !this.devices[id] || dev.driveToken[chNum] !== token;

        // Endlagen als echte open/close-Fahrt: robust, rekalibriert die Schätzung
        if (target === 0 || target === 100) {
            await this.sendChannelCommand(id, chNum, target === 0 ? 'close' : 'open');
            await this.setStateAsync(`${id}.channels.ch${chNum}.setPosition`, { val: target, ack: true });
            return;
        }

        // unbekannte Ausgangsposition: Referenzfahrt zur näheren Endlage
        if (dev.posEstimate[chNum] === undefined) {
            const refCmd = target < 50 ? 'close' : 'open';
            const refPos = target < 50 ? 0 : 100;
            this.log.info(`[${id}] ch${chNum}: Position unbekannt - Referenzfahrt (${refCmd}, ${Math.round(travel / 1000)}s) vor Anfahrt auf ${target}%`);
            await this.sendChannelCommand(id, chNum, refCmd);
            await this.delay(travel + 1000);
            if (aborted()) return;
            dev.posEstimate[chNum] = refPos;
            dev.moveState[chNum] = null;
            await this.setStateAsync(`${id}.channels.ch${chNum}.posEstimate`, { val: refPos, ack: true });
        }

        // Differenz in Fahrzeit umrechnen und in API-konforme Impulse stückeln
        const current = dev.posEstimate[chNum];
        const deltaPct = target - current;
        if (Math.abs(deltaPct) < 1) {
            await this.setStateAsync(`${id}.channels.ch${chNum}.setPosition`, { val: target, ack: true });
            return;
        }
        const dirCmd = deltaPct > 0 ? 'move_open' : 'move_close';
        let remainingMs = Math.round(Math.abs(deltaPct) / 100 * travel);
        if (remainingMs < MIN_TIMED_MS) {
            this.log.debug(`[${id}] ch${chNum}: Differenz ${deltaPct}% ergäbe ${remainingMs}ms < API-Minimum ${MIN_TIMED_MS}ms - keine Fahrt`);
            await this.setStateAsync(`${id}.channels.ch${chNum}.setPosition`, { val: current, ack: true });
            return;
        }

        while (remainingMs > 0) {
            if (aborted()) {
                this.log.debug(`[${id}] ch${chNum}: setPosition-Sequenz abgebrochen`);
                return;
            }
            const pulse = Math.max(MIN_TIMED_MS, Math.min(remainingMs, MAX_TIMED_MS));
            await this.sendChannelCommand(id, chNum, `${dirCmd}_${pulse}`);
            // warten bis der Impuls abgefahren ist (+Puffer), Schätzung aktualisiert
            // updatePositionEstimate automatisch über den bestehenden Timer
            await this.delay(pulse + DRIVE_GAP_MS);
            remainingMs -= pulse;
        }
        if (aborted()) return;
        await this.setStateAsync(`${id}.channels.ch${chNum}.setPosition`, { val: target, ack: true });
        this.log.debug(`[${id}] ch${chNum}: Zielposition ${target}% angefahren (Schätzung)`);
    }

    // ------------------------------------------------------- statische Infos

    async refreshStaticInfo(id) {
        const dev = this.devices[id];
        try {
            const idData = await this.zrapGet(id, '/zrap/id');

            // Verifikation: antwortet hier wirklich ein zeptrion-Gerät?
            if (idData.sys !== undefined && String(idData.sys).toUpperCase() !== 'ZEPTRION') {
                this.log.warn(`[${id}] Host ${dev.cfg.host} antwortet, meldet aber sys="${idData.sys}" statt "ZEPTRION" - vermutlich falsche IP oder kein zeptrion-Gerät!`);
            }
            // Plausibilisierung: Kanalzahl aus dem Gerätetyp ableiten (3340-4-x = 4, 3340-2-x = 2)
            const typeStr = String(idData.type ?? '');
            const m = typeStr.match(/^3340-(\d)-/);
            if (m) {
                const hwChannels = parseInt(m[1], 10);
                if (hwChannels !== dev.cfg.channels) {
                    this.log.warn(`[${id}] Gerätetyp ${typeStr} hat ${hwChannels} Kanäle, konfiguriert sind ${dev.cfg.channels} - bitte in der Instanz-Konfiguration korrigieren.`);
                }
            }

            await this.setStateAsync(`${id}.info.hw`, { val: String(idData.hw ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.sw`, { val: String(idData.sw ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.boot`, { val: String(idData.boot ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.sn`, { val: String(idData.sn ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.sys`, { val: String(idData.sys ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.type`, { val: String(idData.type ?? ''), ack: true });
            await this.setStateAsync(`${id}.info.oen`, { val: String(idData.oen ?? ''), ack: true });

            const netData = await this.zrapGet(id, '/zrap/net');
            for (const key of ['ssid', 'ip', 'mac', 'mode', 'enc', 'mask', 'gw', 'bssid']) {
                if (netData[key] !== undefined) {
                    await this.setStateAsync(`${id}.network.${key}`, { val: String(netData[key]), ack: true });
                }
            }

            const chdesData = await this.zrapGet(id, '/zrap/chdes');
            for (let n = 1; n <= dev.cfg.channels; n++) {
                const chData = chdesData[`ch${n}`];
                if (chData) {
                    await this.setStateAsync(`${id}.channels.ch${n}.name`, { val: String(chData.name ?? ''), ack: true });
                    await this.setStateAsync(`${id}.channels.ch${n}.group`, { val: String(chData.group ?? ''), ack: true });
                    await this.setStateAsync(`${id}.channels.ch${n}.icon`, { val: String(chData.icon ?? ''), ack: true });
                    await this.setStateAsync(`${id}.channels.ch${n}.type`, { val: String(chData.type ?? ''), ack: true });
                    await this.setStateAsync(`${id}.channels.ch${n}.cat`, { val: String(chData.cat ?? ''), ack: true });
                    // im Gerät hinterlegter Kanalname als Objektname übernehmen -
                    // macht Objektbaum und VIS-Auswahl deutlich lesbarer
                    const chName = String(chData.name ?? '').trim();
                    if (chName) {
                        await this.extendObjectAsync(`${id}.channels.ch${n}`, {
                            common: { name: `Kanal ${n} - ${chName}` }
                        });
                    }
                }
            }
            this.markConnected(id, true);
        } catch (err) {
            this.handleDeviceError(id, err, 'refreshStaticInfo');
            return;
        }

        // Optionale Zusatzservices: Fehler hier gelten NICHT als Verbindungsabbruch
        // (z.B. ältere Firmware ohne diese Services), sondern werden nur protokolliert.
        await this.safeRefresh(id, '/zrap/loc', async (data) => {
            if (data.name !== undefined) {
                await this.setStateAsync(`${id}.location.name`, { val: String(data.name), ack: true });
            }
        });
        await this.safeRefresh(id, '/zrap/ntp', async (data) => {
            if (data.url !== undefined) await this.setStateAsync(`${id}.ntp.url`, { val: String(data.url), ack: true });
            if (data.per !== undefined) await this.setStateAsync(`${id}.ntp.per`, { val: parseInt(data.per, 10) || 0, ack: true });
        });
        await this.safeRefresh(id, '/zrap/date', async (data) => {
            if (data.rfc1123 !== undefined) await this.setStateAsync(`${id}.date.rfc1123`, { val: String(data.rfc1123), ack: true });
            if (data.tz !== undefined) await this.setStateAsync(`${id}.date.tz`, { val: String(data.tz), ack: true });
            if (data.dst !== undefined) await this.setStateAsync(`${id}.date.dst`, { val: String(data.dst), ack: true });
        });
    }

    async safeRefresh(id, path, apply) {
        try {
            const data = await this.zrapGet(id, path);
            await apply(data);
        } catch (err) {
            this.log.debug(`[${id}] optionaler Service ${path} nicht verfügbar/fehlgeschlagen: ${err.message || err}`);
        }
    }

    formatOffset(minutes) {
        const sign = minutes >= 0 ? '+' : '-';
        const abs = Math.abs(minutes);
        const hh = String(Math.floor(abs / 60)).padStart(2, '0');
        const mm = String(abs % 60).padStart(2, '0');
        return `${sign}${hh}${mm}`;
    }

    async syncDeviceTime(id) {
        const now = new Date();
        const rfc1123 = now.toUTCString(); // z.B. "Tue, 07 Jul 2026 08:00:00 GMT" - erfüllt "muss GMT sein"
        const tz = this.formatOffset(-now.getTimezoneOffset()); // DST ist in getTimezoneOffset() bereits enthalten
        await this.zrapPost(id, '/zrap/date', { rfc1123, tz, dst: '0000' });
        await this.setStateAsync(`${id}.date.rfc1123`, { val: rfc1123, ack: true });
        await this.setStateAsync(`${id}.date.tz`, { val: tz, ack: true });
        await this.setStateAsync(`${id}.date.dst`, { val: '0000', ack: true });
        this.log.info(`[${id}] Geräte-Zeit synchronisiert: ${rfc1123} (tz=${tz})`);
    }

    // ------------------------------------------------------------- Polling

    startPolling(id) {
        const dev = this.devices[id];
        const loop = async () => {
            if (!this.devices[id]) return; // Adapter wird beendet / Gerät entfernt
            await this.pollDevice(id);
            if (!this.devices[id]) return;
            const backoff = Math.min(dev.fails, 5) || 1;
            dev.timer = this.setTimeout(loop, dev.cfg.pollInterval * backoff);
        };
        // Startversatz (0..3s zufällig): desynchronisiert die Poll-Zyklen vieler
        // Geräte, damit nicht alle 30s ein Request-Burst durchs Netz geht
        // ("Thundering Herd" bei 20+ Geräten).
        dev.timer = this.setTimeout(loop, Math.floor(Math.random() * 3000));
    }

    /**
     * Schreibt einen aus chscan/chnotify gelesenen Kanalwert in den State.
     * @param {boolean} authoritative true=chnotify (Push, immer aktuell/verbindlich),
     *   false=chscan-Resync (Pull, kann bei einem gerade laufenden Bewegungsbefehl
     *   kurzzeitig veraltet sein, siehe COMMAND_SETTLE_MS).
     */
    async applyChannelVal(id, chNum, rawVal, authoritative) {
        const dev = this.devices[id];
        if (!authoritative) {
            const busyUntil = dev.channelBusyUntil[chNum] || 0;
            if (Date.now() < busyUntil) return; // veralteten Resync-Wert verwerfen
        } else {
            delete dev.channelBusyUntil[chNum]; // Push bestätigt neuen Zustand -> Sperre aufheben
        }
        await this.setStateAsync(`${id}.channels.ch${chNum}.val`, { val: parseInt(rawVal, 10), ack: true });
    }

    async pollDevice(id) {
        const dev = this.devices[id];
        dev.pollCount = (dev.pollCount || 0) + 1;
        try {
            // Verbindungs-Ökonomie: die Embedded-Webserver der Aktoren verkraften nur
            // wenige parallele Verbindungen, und chnotify hält bereits dauerhaft eine
            // offen. Solange der Notify-Kanal gesund läuft (connected + notifyHealthy),
            // ist chscan redundant und wird nur jeden 5. Poll als Resync ausgeführt.
            const needChscan = !dev.notifyHealthy || dev.pollCount % 5 === 0;
            if (needChscan) {
                const chscan = await this.zrapGet(id, '/zrap/chscan');
                for (let n = 1; n <= dev.cfg.channels; n++) {
                    const chVal = chscan[`ch${n}`];
                    if (chVal && chVal.val !== undefined) {
                        await this.applyChannelVal(id, n, chVal.val, false);
                    }
                }
            }
            const rssi = await this.zrapGet(id, '/zrap/rssi');
            if (rssi.dbm !== undefined) {
                await this.setStateAsync(`${id}.info.rssi`, { val: parseInt(rssi.dbm, 10), ack: true });
            }
            this.markConnected(id, true);
        } catch (err) {
            this.handleDeviceError(id, err, 'pollDevice');
        }

        if (dev.cfg.smartfront) {
            try {
                const sensor = await this.zapiGet(id, '/zapi/smartfront/sensor');
                if (sensor) {
                    const temp = this.parseSensorNumber(sensor.temp);
                    const lux = this.parseSensorNumber(sensor.lux);
                    const hum = this.parseSensorNumber(sensor.hum);
                    if (temp !== null) await this.setStateAsync(`${id}.smartfront.temp`, { val: temp, ack: true });
                    if (lux !== null) await this.setStateAsync(`${id}.smartfront.lux`, { val: lux, ack: true });
                    if (hum !== null) await this.setStateAsync(`${id}.smartfront.hum`, { val: hum, ack: true });
                }
                const led = await this.zapiGet(id, '/zapi/smartfront/led');
                if (led !== undefined) {
                    await this.setStateAsync(`${id}.smartfront.ledState`, { val: JSON.stringify(led), ack: true });
                }
            } catch (err) {
                this.log.debug(`[${id}] Smartfront (zapi) nicht verfügbar: ${err.message || err}`);
            }
        }
    }

    // --------------------------------------------------------- Notify-Loop

    /**
     * Nutzt zrap/chnotify (Kapitel 3.5 der API-Doku) als Push-ähnlichen Mechanismus:
     * Der Request blockiert am Gerät, bis sich ein Kanal ändert, spätestens aber
     * nach 30s (dann leerer/gleicher Response). So kommen Statusänderungen ohne
     * Warten auf das nächste Poll-Intervall an, und das Race-Condition-Risiko aus
     * dem Audit (Befund 5) entfällt für den Regelfall, weil chnotify-Daten per
     * Definition den soeben eingetretenen, verbindlichen Zustand liefern.
     */
    startNotifyLoop(id) {
        const dev = this.devices[id];
        dev.notifyActive = true;

        const loop = async () => {
            if (!this.devices[id] || !this.devices[id].notifyActive) return;
            let delay = 0;
            try {
                const data = await this.zrapGet(id, '/zrap/chnotify', { timeout: NOTIFY_TIMEOUT_MS });
                for (let n = 1; n <= dev.cfg.channels; n++) {
                    const chVal = data[`ch${n}`];
                    if (chVal && chVal.val !== undefined) {
                        await this.applyChannelVal(id, n, chVal.val, true);
                    }
                }
                this.markConnected(id, true);
                dev.notifyHealthy = true;
            } catch (err) {
                // Laut Doku antwortet das Gerät IMMER binnen 30s (auch ohne Änderung),
                // ein Fehler hier ist also immer ein echter Verbindungsproblem-Fall,
                // keine Sonderbehandlung nötig wie bei einem normalen Request-Timeout.
                dev.notifyHealthy = false;
                this.handleDeviceError(id, err, 'chnotify');
                delay = NOTIFY_ERROR_RETRY_MS;
            }
            if (!this.devices[id] || !this.devices[id].notifyActive) return;
            this.setTimeout(loop, delay);
        };
        loop();
    }

    // --------------------------------------------------- Status / Fehler

    markConnected(id, ok) {
        const dev = this.devices[id];
        if (!dev) return;
        const was = dev.connected;
        dev.connected = ok;
        if (ok) {
            dev.fails = 0;
            this.setStateChangedAsync(`${id}.info.connection`, { val: true, ack: true });
            this.setStateChangedAsync(`${id}.info.lastError`, { val: '', ack: true });
            if (!was) this.log.info(`Gerät ${id} (${dev.cfg.host}) ist erreichbar.`);
        } else {
            dev.fails++;
            this.setStateChangedAsync(`${id}.info.connection`, { val: false, ack: true });
            if (was) this.log.warn(`Gerät ${id} (${dev.cfg.host}) nicht mehr erreichbar.`);
        }
        this.updateGlobalConnection();
    }

    updateGlobalConnection() {
        const anyConnected = Object.values(this.devices).some(d => d.connected);
        this.setStateChangedAsync('info.connection', { val: anyConnected, ack: true });
    }

    handleDeviceError(id, err, context) {
        let msg = (err && err.message) || String(err);
        const code = err && err.code;
        if (code === 'ECONNREFUSED') msg = 'Verbindung verweigert (Gerät aus oder falsche IP?)';
        else if (code === 'ECONNABORTED') msg = 'Zeitüberschreitung (Gerät nicht erreichbar)';
        else if (code === 'EHOSTUNREACH') msg = 'Host nicht erreichbar (Netzwerk/Routing prüfen)';
        else if (code === 'ENOTFOUND') msg = 'Hostname/mDNS-Name nicht auflösbar';
        else if (code === 'ETIMEDOUT') msg = 'Zeitüberschreitung beim Verbindungsaufbau';
        this.log.warn(`[${id}] Fehler bei ${context}: ${msg}`);
        this.setStateAsync(`${id}.info.lastError`, { val: msg, ack: true }).catch(() => {});
        this.markConnected(id, false);
    }

    // --------------------------------------------------------- stateChange

    async onStateChange(idFull, state) {
        if (!state || state.ack) return;
        // KOMPLETTER Handler in try/catch: Fehler in einem Event-Handler würden sonst
        // als Unhandled Promise Rejection den Adapterprozess gefährden (Audit-Befund).
        try {
            await this.routeStateChange(idFull, state);
        } catch (err) {
            const rel = idFull.substring(this.namespace.length + 1);
            const devId = rel.split('.')[0];
            if (this.devices[devId]) {
                this.handleDeviceError(devId, err, `onStateChange(${rel})`);
            } else {
                this.log.warn(`Fehler bei onStateChange(${rel}): ${err.message || err}`);
            }
            if (typeof state.val === 'boolean') {
                await this.setStateAsync(idFull, { val: false, ack: true }).catch(() => {});
            }
        }
    }

    async routeStateChange(idFull, state) {
        const rel = idFull.substring(this.namespace.length + 1);

        if (rel === 'control.closeAllShutters' && state.val) {
            await this.broadcastCommand('close');
            await this.setStateAsync(idFull, { val: false, ack: true });
            return;
        }
        if (rel === 'control.openAllShutters' && state.val) {
            await this.broadcastCommand('open');
            await this.setStateAsync(idFull, { val: false, ack: true });
            return;
        }
        if (rel === 'control.stopAllShutters' && state.val) {
            await this.broadcastCommand('stop');
            await this.setStateAsync(idFull, { val: false, ack: true });
            return;
        }

        const parts = rel.split('.');
        const id = parts[0];
        const dev = this.devices[id];
        if (!dev) return;

        {
            if (parts[1] === 'info' && parts[2] === 'refresh' && state.val) {
                await this.refreshStaticInfo(id);
                await this.setStateAsync(idFull, { val: false, ack: true });
                return;
            }

            if (parts[1] === 'system') {
                if (parts[2] === 'unlock' && state.val) {
                    dev.unlockUntil = Date.now() + 30000;
                    this.log.warn(`[${id}] Werksreset für 30 Sekunden entriegelt.`);
                    await this.setStateAsync(idFull, { val: false, ack: true });
                    return;
                }
                const cmd = SYS_CMDS[parts[2]];
                if (cmd && state.val) {
                    if (cmd === 'factory-default') {
                        // Sicherheitsverriegelung: Werksreset löscht ALLE Einstellungen
                        // inkl. WLAN-Zugang - das Gerät fällt danach vom Netz und muss
                        // physisch neu eingerichtet werden. Ein einzelner (versehent-
                        // licher) setState aus Script/VIS darf das nicht auslösen können.
                        if (!dev.unlockUntil || Date.now() > dev.unlockUntil) {
                            this.log.error(`[${id}] Werksreset ABGELEHNT: zuerst ${id}.system.unlock setzen (30s-Fenster). Das Gerät würde sonst inkl. WLAN-Konfiguration gelöscht und vom Netz fallen.`);
                            await this.setStateAsync(idFull, { val: false, ack: true });
                            return;
                        }
                        dev.unlockUntil = 0;
                        this.log.warn(`[${id}] WERKSRESET wird ausgeführt - Gerät verliert alle Einstellungen inkl. WLAN!`);
                    }
                    await this.zrapPost(id, '/zrap/sys', { cmd });
                    this.log.info(`[${id}] Systembefehl gesendet: ${cmd}`);
                    await this.setStateAsync(idFull, { val: false, ack: true });
                }
                return;
            }

            if (parts[1] === 'location' && parts[2] === 'name') {
                const val = this.validateApiString(state.val, 32, 'location.name');
                await this.zrapPost(id, '/zrap/loc', { name: val });
                await this.setStateAsync(idFull, { val, ack: true });
                return;
            }

            if (parts[1] === 'ntp' && ['url', 'per'].includes(parts[2])) {
                let val = state.val;
                if (parts[2] === 'url') {
                    val = this.validateApiString(val, 32, 'ntp.url');
                } else {
                    val = Math.max(0, Math.min(255, parseInt(val, 10) || 0));
                }
                await this.zrapPost(id, '/zrap/ntp', { [parts[2]]: val });
                await this.setStateAsync(idFull, { val, ack: true });
                return;
            }

            if (parts[1] === 'date') {
                if (parts[2] === 'syncNow' && state.val) {
                    await this.syncDeviceTime(id);
                    await this.setStateAsync(idFull, { val: false, ack: true });
                    return;
                }
                if (['rfc1123', 'tz', 'dst'].includes(parts[2])) {
                    await this.zrapPost(id, '/zrap/date', { [parts[2]]: state.val });
                    await this.setStateAsync(idFull, { val: state.val, ack: true });
                    return;
                }
                return;
            }

            if (parts[1] === 'smartfront' && parts[2] === 'ledSet') {
                let body;
                try {
                    body = JSON.parse(String(state.val));
                } catch (err) {
                    throw new Error(`ledSet: kein gültiges JSON ("${err.message}"). Beispiel: [{"id":2,"bg":"#220000"}]`);
                }
                await this.zapiPost(id, '/zapi/smartfront/led', body);
                await this.setStateAsync(idFull, { val: state.val, ack: true });
                return;
            }

            if (parts[1] === 'channels') {
                const chMatch = (parts[2] || '').match(/^ch(\d+)$/);
                if (!chMatch) return;
                const chNum = parseInt(chMatch[1], 10);
                const action = parts[3];

                if (['name', 'group', 'icon', 'type', 'cat'].includes(action)) {
                    const limits = { name: 32, group: 32, icon: 24, type: 4, cat: 4 };
                    const val = this.validateApiString(state.val, limits[action], `chdes.${action}`);
                    await this.zrapPost(id, `/zrap/chdes/ch${chNum}`, { [action]: val });
                    await this.setStateAsync(idFull, { val, ack: true });
                    return;
                }

                if (action === 'posEstimate') {
                    // read-only seit 0.5.0 - Hinweis für alte Scripts
                    this.log.warn(`[${id}] posEstimate ist jetzt read-only. Zum Kalibrieren "calibrate", zum Anfahren "setPosition" verwenden.`);
                    return;
                }

                if (action === 'calibrate') {
                    // Schätzung setzen OHNE Fahrt (z.B. nach manueller Bedienung am Wandtaster)
                    const v = Math.max(0, Math.min(100, Math.round(Number(state.val))));
                    this.cancelDrive(id, chNum);
                    dev.posEstimate[chNum] = v;
                    dev.moveState[chNum] = null;
                    await this.setStateAsync(`${id}.channels.ch${chNum}.posEstimate`, { val: v, ack: true });
                    await this.setStateAsync(idFull, { val: v, ack: true });
                    return;
                }

                if (action === 'setPosition') {
                    // driveToPosition läuft bewusst OHNE await im Hintergrund weiter -
                    // die Sequenz kann bei langen Laufzeiten Minuten dauern und würde
                    // sonst den stateChange-Handler blockieren. Fehler werden intern
                    // über handleDeviceError gemeldet.
                    this.driveToPosition(id, chNum, state.val).catch(err =>
                        this.handleDeviceError(id, err, `setPosition(ch${chNum})`)
                    );
                    return;
                }

                if (action === 'tiltOpen' || action === 'tiltClose') {
                    if (state.val !== true) return;
                    if (!dev.cfg.tiltTimeMs) {
                        this.log.warn(`[${id}] Kipp-Impuls nicht konfiguriert ("Kipp-Impuls (ms)" in der Geräte-Tabelle setzen, typisch 300-800ms für Rafflamellen).`);
                        await this.setStateAsync(idFull, { val: false, ack: true });
                        return;
                    }
                    const pulse = Math.max(MIN_TIMED_MS, Math.min(dev.cfg.tiltTimeMs, MAX_TIMED_MS));
                    this.cancelDrive(id, chNum);
                    await this.sendChannelCommand(id, chNum, `${action === 'tiltOpen' ? 'move_open' : 'move_close'}_${pulse}`);
                    await this.setStateAsync(idFull, { val: false, ack: true });
                    return;
                }

                if (action === 'command') {
                    this.cancelDrive(id, chNum);
                    await this.sendChannelCommand(id, chNum, String(state.val));
                    await this.setStateAsync(idFull, { val: state.val, ack: true });
                    return;
                }

                if (state.val === true) {
                    // manueller Button unterbricht eine laufende setPosition-Sequenz
                    this.cancelDrive(id, chNum);
                    await this.sendChannelCommand(id, chNum, action);
                    await this.setStateAsync(idFull, { val: false, ack: true });
                }
            }
        }
    }

    async broadcastCommand(cmd) {
        // WICHTIG: alle Kanalbefehle werden ohne Zwischen-await gestartet, damit sie
        // innerhalb desselben COMMAND_BATCH_MS-Fensters landen und pro Gerät zu einem
        // einzigen Multicast-POST gebündelt werden (siehe sendChannelCommand/
        // flushPendingCmds). Sequentielles awaiten würde das Bündeln verhindern, da
        // jeder Aufruf erst nach Abschluss des Debounce-Timers des vorigen auflöst.
        const promises = [];
        for (const id of Object.keys(this.devices)) {
            const dev = this.devices[id];
            for (let n = 1; n <= dev.cfg.channels; n++) {
                this.cancelDrive(id, n); // Sammelbefehl (z.B. Hagelalarm) hat Vorrang vor laufenden setPosition-Sequenzen
                promises.push(
                    this.sendChannelCommand(id, n, cmd).catch(err => {
                        this.handleDeviceError(id, err, `broadcastCommand(${cmd})`);
                    })
                );
            }
        }
        await Promise.allSettled(promises);
    }

    // ------------------------------------------------------------ Discovery

    /**
     * mDNS-Discovery gemäss Kapitel 4 der API-Doku.
     * Aktuelle Firmware (>= 01.08.xx) meldet sich als _zapp._tcp,
     * ältere Firmware nur als _http._tcp (dort per Hostname-Muster zapp-YYWWNNNN gefiltert).
     */
    discoverDevices(timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            if (!Bonjour) {
                reject(new Error('Modul "bonjour-service" ist nicht installiert. "npm install bonjour-service" im Adapterverzeichnis ausführen.'));
                return;
            }
            const bonjour = new Bonjour();
            const found = new Map();

            // WICHTIG: dieser Callback wird asynchron aus dem EventEmitter von
            // bonjour-service heraus aufgerufen, für JEDES gesehene mDNS-Gerät im
            // Netz (auch Sonos/Chromecast/Drucker etc. bei "type: 'http'"). Ein
            // hier ungefangener Fehler (z.B. durch unerwartete/fehlende Felder in
            // einem fremden TXT-Record) würde NICHT vom äusseren try/catch dieser
            // Funktion abgedeckt, sondern könnte als unhandled exception den ganzen
            // Adapterprozess crashen. Daher hart mit try/catch abgesichert.
            const handle = (service) => {
                try {
                    const name = (service && (service.name || service.host)) || '';
                    const addresses = Array.isArray(service && service.addresses) ? service.addresses : [];
                    const addr = addresses.find(a => typeof a === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a));
                    const host = addr || (service && service.host);
                    if (!host) return;
                    const txt = (service && service.txt) || {};
                    const type = (txt && txt.type) || '';
                    let channels = 1;
                    if (/^3340-4-/.test(type)) channels = 4;
                    else if (/^3340-2-/.test(type)) channels = 2;
                    found.set(host, {
                        name: String(name).replace(/\.local\.?$/i, ''),
                        host,
                        type,
                        sw: txt.sw || '',
                        channels
                    });
                } catch (err) {
                    this.log.debug(`Discovery: unerwartetes/fremdes mDNS-Paket ignoriert (${err.message || err})`);
                }
            };

            let browserNew;
            let browserOld;
            try {
                browserNew = bonjour.find({ type: 'zapp' }, handle);
                browserOld = bonjour.find({ type: 'http' }, (service) => {
                    try {
                        if (service && service.name && /^zapp-\d{8}$/i.test(service.name)) handle(service);
                    } catch (err) {
                        this.log.debug(`Discovery: Fallback-Filter (_http._tcp) Fehler ignoriert (${err.message || err})`);
                    }
                });
                // Auch auf explizite Fehler-Events der Browser reagieren, statt sie
                // als unhandled 'error' durchfallen zu lassen.
                if (browserNew && typeof browserNew.on === 'function') {
                    browserNew.on('error', err => this.log.debug(`Discovery (_zapp._tcp) Fehler: ${err.message || err}`));
                }
                if (browserOld && typeof browserOld.on === 'function') {
                    browserOld.on('error', err => this.log.debug(`Discovery (_http._tcp) Fehler: ${err.message || err}`));
                }
            } catch (err) {
                try { bonjour.destroy(); } catch (e) { /* ignore */ }
                reject(err);
                return;
            }

            this.setTimeout(() => {
                try { browserNew && browserNew.stop(); } catch (e) { /* ignore */ }
                try { browserOld && browserOld.stop(); } catch (e) { /* ignore */ }
                try { bonjour.destroy(); } catch (e) { /* ignore */ }
                resolve(Array.from(found.values()));
            }, timeoutMs);
        });
    }

    /** Übernimmt neu gefundene Geräte deaktiviert in die Instanz-Konfiguration (native.devices). */
    async mergeDiscoveredDevices(results) {
        const instObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (!instObj) return 0;
        const devices = Array.isArray(instObj.native.devices) ? instObj.native.devices : [];
        const existingHosts = new Set(devices.map(d => String(d.host || '').toLowerCase()));
        let added = 0;

        for (const r of results) {
            if (existingHosts.has(String(r.host).toLowerCase())) continue;
            devices.push({
                enabled: false,
                id: this.sanitize(r.name || r.host),
                name: r.name || r.host,
                host: r.host,
                channels: r.channels || 1,
                kind: 'unknown',
                pollInterval: 30
            });
            existingHosts.add(String(r.host).toLowerCase());
            added++;
        }

        if (added > 0) {
            instObj.native.devices = devices;
            await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
        }
        return added;
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;

        if (obj.command === 'importCsv') {
            try {
                const csv = String((obj.message && obj.message.csv) || '').trim();
                if (!csv) {
                    if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'CSV-Feld ist leer. Format: host;name;kanäle;art;laufzeit_s;kipp_ms;smartfront;poll_s;laufzeit_kanal_s (nur host ist Pflicht).' }, obj.callback);
                    return;
                }
                const delim = csv.includes(';') ? ';' : ',';
                const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                // optionale Kopfzeile erkennen und überspringen
                if (lines.length && /^host\b/i.test(lines[0])) lines.shift();

                const instObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
                const devices = Array.isArray(instObj?.native?.devices) ? instObj.native.devices : [];
                const existingHosts = new Set(devices.map(d => String(d.host || '').trim().toLowerCase()));
                const existingIds = new Set(devices.map(d => this.sanitize(d.id || '')));

                const report = [];
                let added = 0;
                for (let i = 0; i < lines.length; i++) {
                    const c = lines[i].split(delim).map(x => x.trim());
                    const row = {
                        host: c[0] || '',
                        name: c[1] || '',
                        channels: c[2] || 1,
                        kind: (c[3] || 'unknown').toLowerCase(),
                        travelTimeSec: c[4] || 0,
                        tiltTimeMs: c[5] || 0,
                        smartfront: /^(1|true|ja|yes|x)$/i.test(c[6] || ''),
                        pollInterval: c[7] || 30,
                        travelTimeSecCh: c[8] || ''
                    };
                    // Kurzformen für "Art" erlauben
                    if (['storen', 'rolladen', 'shutter', 'blinds'].includes(row.kind)) row.kind = 'blind';
                    if (['licht', 'lampe'].includes(row.kind)) row.kind = 'light';

                    const errs = this.validateDeviceRow(row);
                    if (existingHosts.has(row.host.toLowerCase())) errs.push('Host bereits konfiguriert');
                    if (errs.length) {
                        report.push(`❌ Zeile ${i + 1} (${row.host || '?'}): ${errs.join('; ')}`);
                        continue;
                    }
                    // ID aus Host ableiten, Kollisionen auflösen
                    let base = row.host.replace(/\.local\.?$/i, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
                    if (/^\d/.test(base)) base = 'zapp_' + base;
                    let candidate = base || 'device';
                    let n = 2;
                    while (existingIds.has(candidate)) candidate = `${base}_${n++}`;

                    devices.push({
                        enabled: true,
                        id: candidate,
                        name: row.name || row.host,
                        host: row.host,
                        channels: parseInt(String(row.channels), 10) || 1,
                        kind: row.kind,
                        travelTimeSec: parseInt(String(row.travelTimeSec), 10) || 0,
                        travelTimeSecCh: String(row.travelTimeSecCh || '').trim(),
                        tiltTimeMs: parseInt(String(row.tiltTimeMs), 10) || 0,
                        smartfront: row.smartfront,
                        pollInterval: parseInt(String(row.pollInterval), 10) || 30
                    });
                    existingHosts.add(row.host.toLowerCase());
                    existingIds.add(candidate);
                    report.push(`✅ Zeile ${i + 1}: ${row.name || row.host} (${row.host}) als "${candidate}" übernommen`);
                    added++;
                }

                if (added > 0 && instObj) {
                    instObj.native.devices = devices;
                    await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
                }
                const result = `${added} von ${lines.length} Zeile(n) importiert.${added ? ' Adapter startet neu; Dialog schliessen und neu öffnen.' : ''}\n\n${report.join('\n')}`;
                this.log.info(`CSV-Import: ${added}/${lines.length} übernommen`);
                if (obj.callback) this.sendTo(obj.from, obj.command, { result }, obj.callback);
            } catch (err) {
                const msg = `CSV-Import fehlgeschlagen: ${err.message || err}`;
                this.log.warn(msg);
                if (obj.callback) this.sendTo(obj.from, obj.command, { error: msg }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testDevices') {
            const devicesCfg = Array.isArray(this.config.devices) ? this.config.devices : [];
            const rows = devicesCfg.filter(d => d && d.host);
            if (!rows.length) {
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: 'Keine Geräte mit Host in der Tabelle.' }, obj.callback);
                return;
            }
            const lines = [];
            for (const d of rows) {
                const host = String(d.host).trim();
                const label = d.name || d.id || host;
                // IP-Format grob prüfen (Hostnamen sind auch erlaubt)
                if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
                    const octets = host.split('.').map(Number);
                    if (octets.some(o => o > 255)) {
                        lines.push(`❌ ${label} (${host}): ungültige IP-Adresse`);
                        continue;
                    }
                }
                try {
                    const res = await axios.get(`http://${host}/zrap/id`, {
                        timeout: 3000, responseType: 'text', transformResponse: [x => x]
                    });
                    const parsed = xmlParser.parse(res.data || '');
                    const rootKey = Object.keys(parsed).find(k => !k.startsWith('?'));
                    const idData = (rootKey && parsed[rootKey]) || {};
                    if (String(idData.sys ?? '').toUpperCase() === 'ZEPTRION') {
                        const m = String(idData.type ?? '').match(/^3340-(\d)-/);
                        const ch = m ? `, ${m[1]} Kanäle` : '';
                        lines.push(`✅ ${label} (${host}): zeptrion ${idData.type ?? '?'}${ch}, SW ${idData.sw ?? '?'}, SN ${idData.sn ?? '?'}`);
                    } else {
                        lines.push(`⚠️ ${label} (${host}): antwortet, aber KEIN zeptrion-Gerät (sys="${idData.sys ?? 'unbekannt'}")`);
                    }
                } catch (err) {
                    const code = err.code || (err.message || '').substring(0, 40);
                    lines.push(`❌ ${label} (${host}): nicht erreichbar (${code})`);
                }
            }
            const result = lines.join('\n');
            this.log.info(`Gerätetest:\n${result}`);
            if (obj.callback) this.sendTo(obj.from, obj.command, { result }, obj.callback);
            return;
        }

        if (obj.command === 'discover') {
            try {
                this.log.info('Starte mDNS-Discovery nach zeptrion-Geräten …');
                const results = await this.discoverDevices(4000);
                const added = await this.mergeDiscoveredDevices(results);
                const msg = `Suche abgeschlossen: ${results.length} Gerät(e) im Netz gefunden, ${added} neu (deaktiviert) übernommen. ` +
                    `Instanz-Konfiguration schliessen und neu öffnen, um sie in der Tabelle zu sehen und zu aktivieren.`;
                this.log.info(msg);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { result: msg, devices: results }, obj.callback);
                }
            } catch (err) {
                const msg = err.message || String(err);
                this.log.warn(`Discovery fehlgeschlagen: ${msg}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: msg }, obj.callback);
                }
            }
        }
    }

    // -------------------------------------------------------------- unload

    onUnload(callback) {
        try {
            for (const id of Object.keys(this.devices)) {
                const dev = this.devices[id];
                if (dev.timer) this.clearTimeout(dev.timer);
                if (dev.pendingTimer) this.clearTimeout(dev.pendingTimer);
                dev.notifyActive = false;
            }
            this.devices = {};
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Zeptrion(options);
} else {
    new Zeptrion();
}
