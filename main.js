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
const { I18n } = require('@iobroker/adapter-core');
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
    stop: { en: 'Stop', de: 'Stopp', ru: 'Стоп', pt: 'Parar', nl: 'Stop', fr: 'Arrêt', it: 'Stop', es: 'Detener', pl: 'Stop', uk: 'Стоп', 'zh-cn': '停止' },
    on: { en: 'On (100%)', de: 'Ein (100%)', ru: 'Вкл (100%)', pt: 'Ligado (100%)', nl: 'Aan (100%)', fr: 'Marche (100%)', it: 'Acceso (100%)', es: 'Encendido (100%)', pl: 'Wł. (100%)', uk: 'Увімк (100%)', 'zh-cn': '开 (100%)' },
    off: { en: 'Off (0%)', de: 'Aus (0%)', ru: 'Выкл (0%)', pt: 'Desligado (0%)', nl: 'Uit (0%)', fr: 'Arrêt (0%)', it: 'Spento (0%)', es: 'Apagado (0%)', pl: 'Wył. (0%)', uk: 'Вимк (0%)', 'zh-cn': '关 (0%)' },
    toggle: { en: 'Toggle', de: 'Umschalten', ru: 'Переключить', pt: 'Alternar', nl: 'Omschakelen', fr: 'Basculer', it: 'Commuta', es: 'Alternar', pl: 'Przełącz', uk: 'Перемкнути', 'zh-cn': '切换' },
    open: { en: 'Open', de: 'Öffnen', ru: 'Открыть', pt: 'Abrir', nl: 'Openen', fr: 'Ouvrir', it: 'Apri', es: 'Abrir', pl: 'Otwórz', uk: 'Відкрити', 'zh-cn': '打开' },
    close: { en: 'Close', de: 'Schliessen', ru: 'Закрыть', pt: 'Fechar', nl: 'Sluiten', fr: 'Fermer', it: 'Chiudi', es: 'Cerrar', pl: 'Zamknij', uk: 'Закрити', 'zh-cn': '关闭' },
    move_open: { en: 'Open (hold button)', de: 'Öffnen (Taste halten)', ru: 'Открыть (удерж. кнопку)', pt: 'Abrir (manter botão)', nl: 'Openen (knop ingedrukt houden)', fr: 'Ouvrir (maintenir le bouton)', it: 'Apri (tieni premuto)', es: 'Abrir (mantener pulsado)', pl: 'Otwórz (przytrzymaj przycisk)', uk: 'Відкрити (утримувати кнопку)', 'zh-cn': '打开（长按按钮）' },
    move_close: { en: 'Close (hold button)', de: 'Schliessen (Taste halten)', ru: 'Закрыть (удерж. кнопку)', pt: 'Fechar (manter botão)', nl: 'Sluiten (knop ingedrukt houden)', fr: 'Fermer (maintenir le bouton)', it: 'Chiudi (tieni premuto)', es: 'Cerrar (mantener pulsado)', pl: 'Zamknij (przytrzymaj przycisk)', uk: 'Закрити (утримувати кнопку)', 'zh-cn': '关闭（长按按钮）' },
    dim_up: { en: 'Dim up (hold button)', de: 'Dimmen hoch (Taste halten)', ru: 'Увеличить яркость (удерж. кнопку)', pt: 'Aumentar luminosidade (manter botão)', nl: 'Dimmen omhoog (knop ingedrukt houden)', fr: 'Augmenter la lumière (maintenir le bouton)', it: 'Aumenta luminosità (tieni premuto)', es: 'Aumentar brillo (mantener pulsado)', pl: 'Rozjaśnij (przytrzymaj przycisk)', uk: 'Збільшити яскравість (утримувати кнопку)', 'zh-cn': '调亮（长按按钮）' },
    dim_down: { en: 'Dim down (hold button)', de: 'Dimmen runter (Taste halten)', ru: 'Уменьшить яркость (удерж. кнопку)', pt: 'Diminuir luminosidade (manter botão)', nl: 'Dimmen omlaag (knop ingedrukt houden)', fr: 'Diminuer la lumière (maintenir le bouton)', it: 'Diminuisci luminosità (tieni premuto)', es: 'Disminuir brillo (mantener pulsado)', pl: 'Przyciemnij (przytrzymaj przycisk)', uk: 'Зменшити яскравість (утримувати кнопку)', 'zh-cn': '调暗（长按按钮）' }
};

// Value-based migration table: maps a plain-string common.name (as created by versions <1.0.8)
// to the corresponding full 11-language i18n object. Used in migrateObjectRoles() to force-
// correct EXISTING objects on already-running installations (setObjectNotExistsAsync/ensureState
// only ever create, they never update an object that already exists). Deliberately a strict,
// exact-match lookup - not a "contains German characters" heuristic - so user-configured device/
// room names (e.g. "Buero", "Kueche") can never accidentally match and get overwritten.
    const NAME_MIGRATION_MAP = {
        'ACHTUNG: Werksreset - löscht ALLE Einstellungen inkl. WLAN, Gerät fällt vom Netz! Erfordert vorheriges system.unlock (30s-Fenster)': { en: 'WARNING: Factory reset - deletes ALL settings incl. WLAN, device will drop off the network! Requires prior system.unlock (30s window)', de: 'ACHTUNG: Werksreset - löscht ALLE Einstellungen inkl. WLAN, Gerät fällt vom Netz! Erfordert vorheriges system.unlock (30s-Fenster)', ru: 'ВНИМАНИЕ: сброс до заводских настроек - удаляет ВСЕ настройки, вкл. WLAN, устройство отключится от сети! Требуется предварительный system.unlock (окно 30с)', pt: 'ATENÇÃO: reposição de fábrica - apaga TODAS as definições incl. WLAN, o dispositivo sairá da rede! Requer system.unlock prévio (janela de 30s)', nl: 'LET OP: fabrieksreset - wist ALLE instellingen incl. WLAN, apparaat valt van het netwerk! Vereist voorafgaand system.unlock (30s-venster)', fr: 'ATTENTION : réinitialisation d\'usine - supprime TOUS les réglages, y compris le WLAN, l\'appareil sera déconnecté du réseau ! Nécessite un system.unlock préalable (fenêtre de 30s)', it: 'ATTENZIONE: ripristino di fabbrica - cancella TUTTE le impostazioni incl. WLAN, il dispositivo si disconnette dalla rete! Richiede system.unlock preventivo (finestra di 30s)', es: 'ATENCIÓN: restablecimiento de fábrica - borra TODOS los ajustes incl. WLAN, ¡el dispositivo se desconectará de la red! Requiere system.unlock previo (ventana de 30s)', pl: 'UWAGA: przywrócenie ustawień fabrycznych - usuwa WSZYSTKIE ustawienia wraz z WLAN, urządzenie odłączy się od sieci! Wymaga wcześniejszego system.unlock (okno 30s)', uk: 'УВАГА: скидання до заводських налаштувань - видаляє ВСІ налаштування, включно з WLAN, пристрій відключиться від мережі! Потрібен попередній system.unlock (вікно 30с)', 'zh-cn': '警告：恢复出厂设置 - 将删除所有设置（包括 WLAN），设备将离线！需要事先执行 system.unlock（30秒窗口）' },
        'ALLE Storen schliessen (z.B. Hagelalarm)': { en: 'Close ALL shutters (e.g. hail alarm)', de: 'ALLE Storen schliessen (z.B. Hagelalarm)', ru: 'Закрыть ВСЕ жалюзи (напр. градовая тревога)', pt: 'Fechar TODOS os estores (p.ex. alarme de granizo)', nl: 'ALLE zonweringen sluiten (bijv. hagelalarm)', fr: 'Fermer TOUS les stores (p.ex. alarme grêle)', it: 'Chiudi TUTTE le tapparelle (es. allarme grandine)', es: 'Cerrar TODAS las persianas (p.ej. alarma de granizo)', pl: 'Zamknij WSZYSTKIE rolety (np. alarm gradowy)', uk: 'Закрити ВСІ жалюзі (напр. градова тривога)', 'zh-cn': '关闭所有卷帘（例如冰雹警报）' },
        'Abfrageintervall in Stunden (0=deaktiviert)': { en: 'Polling interval in hours (0=disabled)', de: 'Abfrageintervall in Stunden (0=deaktiviert)', ru: 'Интервал опроса в часах (0=отключено)', pt: 'Intervalo de consulta em horas (0=desativado)', nl: 'Poll-interval in uren (0=uitgeschakeld)', fr: 'Intervalle d\'interrogation en heures (0=désactivé)', it: 'Intervallo di polling in ore (0=disattivato)', es: 'Intervalo de consulta en horas (0=desactivado)', pl: 'Interwał odpytywania w godzinach (0=wyłączone)', uk: 'Інтервал опитування в годинах (0=вимкнено)', 'zh-cn': '轮询间隔（小时，0=禁用）' },
        'Aktueller LED-Status (JSON, read-only)': { en: 'Current LED status (JSON, read-only)', de: 'Aktueller LED-Status (JSON, read-only)', ru: 'Текущий статус светодиода (JSON, только чтение)', pt: 'Estado atual do LED (JSON, só leitura)', nl: 'Huidige LED-status (JSON, alleen-lezen)', fr: 'État actuel de la LED (JSON, lecture seule)', it: 'Stato attuale del LED (JSON, sola lettura)', es: 'Estado actual del LED (JSON, solo lectura)', pl: 'Aktualny stan LED (JSON, tylko do odczytu)', uk: 'Поточний стан світлодіода (JSON, лише читання)', 'zh-cn': '当前 LED 状态（JSON，只读）' },
        'Alle Storen stoppen': { en: 'Stop all shutters', de: 'Alle Storen stoppen', ru: 'Остановить все жалюзи', pt: 'Parar todos os estores', nl: 'Alle zonweringen stoppen', fr: 'Arrêter tous les stores', it: 'Ferma tutte le tapparelle', es: 'Detener todas las persianas', pl: 'Zatrzymaj wszystkie rolety', uk: 'Зупинити всі жалюзі', 'zh-cn': '停止所有卷帘' },
        'Alle Storen öffnen': { en: 'Open all shutters', de: 'Alle Storen öffnen', ru: 'Открыть все жалюзи', pt: 'Abrir todos os estores', nl: 'Alle zonweringen openen', fr: 'Ouvrir tous les stores', it: 'Apri tutte le tapparelle', es: 'Abrir todas las persianas', pl: 'Otwórz wszystkie rolety', uk: 'Відкрити всі жалюзі', 'zh-cn': '打开所有卷帘' },
        'Bootloader-Version': { en: 'Bootloader version', de: 'Bootloader-Version', ru: 'Версия загрузчика', pt: 'Versão do bootloader', nl: 'Bootloaderversie', fr: 'Version du bootloader', it: 'Versione bootloader', es: 'Versión del bootloader', pl: 'Wersja bootloadera', uk: 'Версія завантажувача', 'zh-cn': '引导程序版本' },
        'Button: Geräte-Uhrzeit mit ioBroker-Host synchronisieren': { en: 'Button: synchronize device time with the ioBroker host', de: 'Button: Geräte-Uhrzeit mit ioBroker-Host synchronisieren', ru: 'Кнопка: синхронизировать время устройства с хостом ioBroker', pt: 'Botão: sincronizar hora do dispositivo com o host ioBroker', nl: 'Knop: apparaatklok synchroniseren met de ioBroker-host', fr: 'Bouton : synchroniser l\'heure de l\'appareil avec l\'hôte ioBroker', it: 'Pulsante: sincronizza l\'ora del dispositivo con l\'host ioBroker', es: 'Botón: sincronizar la hora del dispositivo con el host de ioBroker', pl: 'Przycisk: synchronizuj czas urządzenia z hostem ioBroker', uk: 'Кнопка: синхронізувати час пристрою з хостом ioBroker', 'zh-cn': '按钮：将设备时间与 ioBroker 主机同步' },
        'Datum/Zeit': { en: 'Date/time', de: 'Datum/Zeit', ru: 'Дата/время', pt: 'Data/hora', nl: 'Datum/tijd', fr: 'Date/heure', it: 'Data/ora', es: 'Fecha/hora', pl: 'Data/godzina', uk: 'Дата/час', 'zh-cn': '日期/时间' },
        'Entriegelung für Werksreset (Sicherheitsverriegelung: muss max. 30s VOR factoryDefault auf true gesetzt werden)': { en: 'Unlock for factory reset (safety interlock: must be set to true max. 30s BEFORE factoryDefault)', de: 'Entriegelung für Werksreset (Sicherheitsverriegelung: muss max. 30s VOR factoryDefault auf true gesetzt werden)', ru: 'Разблокировка для сброса до заводских настроек (интерлок: должно быть true не более чем за 30с ДО factoryDefault)', pt: 'Desbloqueio para reposição de fábrica (interbloqueio de segurança: deve ser definido como true no máx. 30s ANTES de factoryDefault)', nl: 'Ontgrendeling voor fabrieksreset (veiligheidsvergrendeling: moet max. 30s VOOR factoryDefault op true gezet worden)', fr: 'Déverrouillage pour réinitialisation d\'usine (verrouillage de sécurité : doit être mis à true max. 30s AVANT factoryDefault)', it: 'Sblocco per il ripristino di fabbrica (interblocco di sicurezza: deve essere impostato su true max. 30s PRIMA di factoryDefault)', es: 'Desbloqueo para restablecimiento de fábrica (enclavamiento de seguridad: debe ponerse a true máx. 30s ANTES de factoryDefault)', pl: 'Odblokowanie przywracania ustawień fabrycznych (blokada bezpieczeństwa: musi być ustawione na true maks. 30s PRZED factoryDefault)', uk: 'Розблокування для скидання до заводських налаштувань (блокування безпеки: має бути true не більше ніж за 30с ДО factoryDefault)', 'zh-cn': '解锁恢复出厂设置（安全联锁：必须在 factoryDefault 之前最多 30 秒设置为 true）' },
        'Freier Befehl (z.B. dim_2000, move_close_5000, recall_s1 …)': { en: 'Free-text command (e.g. dim_2000, move_close_5000, recall_s1 ...)', de: 'Freier Befehl (z.B. dim_2000, move_close_5000, recall_s1 …)', ru: 'Произвольная команда (напр. dim_2000, move_close_5000, recall_s1 …)', pt: 'Comando livre (p.ex. dim_2000, move_close_5000, recall_s1 …)', nl: 'Vrije opdracht (bijv. dim_2000, move_close_5000, recall_s1 …)', fr: 'Commande libre (p.ex. dim_2000, move_close_5000, recall_s1 …)', it: 'Comando libero (es. dim_2000, move_close_5000, recall_s1 …)', es: 'Comando libre (p.ej. dim_2000, move_close_5000, recall_s1 …)', pl: 'Dowolne polecenie (np. dim_2000, move_close_5000, recall_s1 …)', uk: 'Довільна команда (напр. dim_2000, move_close_5000, recall_s1 …)', 'zh-cn': '自由命令（例如 dim_2000, move_close_5000, recall_s1 …）' },
        'Geräteinformationen': { en: 'Device information', de: 'Geräteinformationen', ru: 'Информация об устройстве', pt: 'Informação do dispositivo', nl: 'Apparaatinformatie', fr: 'Informations sur l\'appareil', it: 'Informazioni sul dispositivo', es: 'Información del dispositivo', pl: 'Informacje o urządzeniu', uk: 'Інформація про пристрій', 'zh-cn': '设备信息' },
        'Gerätetyp (Device ID)': { en: 'Device type (Device ID)', de: 'Gerätetyp (Device ID)', ru: 'Тип устройства (Device ID)', pt: 'Tipo de dispositivo (Device ID)', nl: 'Apparaattype (Device ID)', fr: 'Type d\'appareil (Device ID)', it: 'Tipo di dispositivo (Device ID)', es: 'Tipo de dispositivo (Device ID)', pl: 'Typ urządzenia (Device ID)', uk: 'Тип пристрою (Device ID)', 'zh-cn': '设备类型 (Device ID)' },
        'Gruppe (chdes)': { en: 'Group (chdes)', de: 'Gruppe (chdes)', ru: 'Группа (chdes)', pt: 'Grupo (chdes)', nl: 'Groep (chdes)', fr: 'Groupe (chdes)', it: 'Gruppo (chdes)', es: 'Grupo (chdes)', pl: 'Grupa (chdes)', uk: 'Група (chdes)', 'zh-cn': '分组 (chdes)' },
        'Hardware-Version': { en: 'Hardware version', de: 'Hardware-Version', ru: 'Версия оборудования', pt: 'Versão do hardware', nl: 'Hardwareversie', fr: 'Version matérielle', it: 'Versione hardware', es: 'Versión de hardware', pl: 'Wersja sprzętu', uk: 'Версія обладнання', 'zh-cn': '硬件版本' },
        'Helligkeit': { en: 'Brightness', de: 'Helligkeit', ru: 'Яркость', pt: 'Luminosidade', nl: 'Helderheid', fr: 'Luminosité', it: 'Luminosità', es: 'Luminosidad', pl: 'Jasność', uk: 'Яскравість', 'zh-cn': '亮度' },
        'Icon (chdes)': { en: 'Icon (chdes)', de: 'Icon (chdes)', ru: 'Иконка (chdes)', pt: 'Ícone (chdes)', nl: 'Icoon (chdes)', fr: 'Icône (chdes)', it: 'Icona (chdes)', es: 'Icono (chdes)', pl: 'Ikona (chdes)', uk: 'Іконка (chdes)', 'zh-cn': '图标 (chdes)' },
        'Kanalname (chdes)': { en: 'Channel name (chdes)', de: 'Kanalname (chdes)', ru: 'Имя канала (chdes)', pt: 'Nome do canal (chdes)', nl: 'Kanaalnaam (chdes)', fr: 'Nom du canal (chdes)', it: 'Nome canale (chdes)', es: 'Nombre del canal (chdes)', pl: 'Nazwa kanału (chdes)', uk: 'Ім\'я каналу (chdes)', 'zh-cn': '通道名称 (chdes)' },
        'Kanäle': { en: 'Channels', de: 'Kanäle', ru: 'Каналы', pt: 'Canais', nl: 'Kanalen', fr: 'Canaux', it: 'Canali', es: 'Canales', pl: 'Kanały', uk: 'Канали', 'zh-cn': '通道' },
        'Kategorie-Code (chdes)': { en: 'Category code (chdes)', de: 'Kategorie-Code (chdes)', ru: 'Код категории (chdes)', pt: 'Código de categoria (chdes)', nl: 'Categoriecode (chdes)', fr: 'Code de catégorie (chdes)', it: 'Codice categoria (chdes)', es: 'Código de categoría (chdes)', pl: 'Kod kategorii (chdes)', uk: 'Код категорії (chdes)', 'zh-cn': '类别代码 (chdes)' },
        'LED(s) setzen - JSON-Array wie in API-Doku 5.1.3.4, z.B. [{"id":2,"bg":"#220000"}]. Laut Doku nur "bg" (Hintergrundfarbe) unbedenklich extern setzbar.': { en: 'Set LED(s) - JSON array as in API doc 5.1.3.4, e.g. [{"id":2,"bg":"#220000"}]. Per the docs, only "bg" (background color) is safe to set externally.', de: 'LED(s) setzen - JSON-Array wie in API-Doku 5.1.3.4, z.B. [{"id":2,"bg":"#220000"}]. Laut Doku nur "bg" (Hintergrundfarbe) unbedenklich extern setzbar.', ru: 'Установить LED - JSON-массив как в документации API 5.1.3.4, напр. [{"id":2,"bg":"#220000"}]. Согласно документации, только "bg" (цвет фона) безопасно устанавливать извне.', pt: 'Definir LED(s) - array JSON conforme doc. API 5.1.3.4, p.ex. [{"id":2,"bg":"#220000"}]. Segundo a documentação, apenas "bg" (cor de fundo) pode ser definido externamente com segurança.', nl: 'LED(s) instellen - JSON-array zoals in API-doc 5.1.3.4, bijv. [{"id":2,"bg":"#220000"}]. Volgens de documentatie is alleen "bg" (achtergrondkleur) veilig extern instelbaar.', fr: 'Définir la/les LED - tableau JSON comme dans la doc API 5.1.3.4, p.ex. [{"id":2,"bg":"#220000"}]. Selon la doc, seul "bg" (couleur de fond) peut être défini en externe sans risque.', it: 'Imposta LED - array JSON come da documentazione API 5.1.3.4, es. [{"id":2,"bg":"#220000"}]. Secondo la documentazione, solo "bg" (colore di sfondo) è sicuro da impostare esternamente.', es: 'Definir LED(s) - array JSON como en la doc. API 5.1.3.4, p.ej. [{"id":2,"bg":"#220000"}]. Según la documentación, solo "bg" (color de fondo) es seguro de establecer externamente.', pl: 'Ustaw LED - tablica JSON jak w dokumentacji API 5.1.3.4, np. [{"id":2,"bg":"#220000"}]. Wg dokumentacji tylko "bg" (kolor tła) można bezpiecznie ustawiać zewnętrznie.', uk: 'Встановити світлодіоди - JSON-масив як у документації API 5.1.3.4, напр. [{"id":2,"bg":"#220000"}]. Згідно з документацією, лише "bg" (колір фону) безпечно встановлювати ззовні.', 'zh-cn': '设置 LED - JSON 数组，格式见 API 文档 5.1.3.4，例如 [{"id":2,"bg":"#220000"}]。根据文档，仅 "bg"（背景色）可安全地从外部设置。' },
        'Letzter Fehler': { en: 'Last error', de: 'Letzter Fehler', ru: 'Последняя ошибка', pt: 'Último erro', nl: 'Laatste fout', fr: 'Dernière erreur', it: 'Ultimo errore', es: 'Último error', pl: 'Ostatni błąd', uk: 'Остання помилка', 'zh-cn': '最近错误' },
        'Luftfeuchtigkeit': { en: 'Humidity', de: 'Luftfeuchtigkeit', ru: 'Влажность', pt: 'Humidade', nl: 'Luchtvochtigheid', fr: 'Humidité', it: 'Umidità', es: 'Humedad', pl: 'Wilgotność', uk: 'Вологість', 'zh-cn': '湿度' },
        'Mindestens ein Gerät erreichbar': {
                                en: 'At least one device reachable',
                                de: 'Mindestens ein Gerät erreichbar',
                                ru: 'Доступно хотя бы одно устройство',
                                pt: 'Pelo menos um dispositivo acessível',
                                nl: 'Ten minste één apparaat bereikbaar',
                                fr: 'Au moins un appareil accessible',
                                it: 'Almeno un dispositivo raggiungibile',
                                es: 'Al menos un dispositivo accesible',
                                pl: 'Co najmniej jedno urządzenie dostępne',
                                uk: 'Принаймні один пристрій доступний',
                                'zh-cn': '至少有一个设备可访问'
                            },
        'NTP': { en: 'NTP', de: 'NTP', ru: 'NTP', pt: 'NTP', nl: 'NTP', fr: 'NTP', it: 'NTP', es: 'NTP', pl: 'NTP', uk: 'NTP', 'zh-cn': 'NTP' },
        'NTP-Server (URL/IP, max. 32 Zeichen)': { en: 'NTP server (URL/IP, max. 32 characters)', de: 'NTP-Server (URL/IP, max. 32 Zeichen)', ru: 'NTP-сервер (URL/IP, макс. 32 символа)', pt: 'Servidor NTP (URL/IP, máx. 32 caracteres)', nl: 'NTP-server (URL/IP, max. 32 tekens)', fr: 'Serveur NTP (URL/IP, max. 32 caractères)', it: 'Server NTP (URL/IP, max. 32 caratteri)', es: 'Servidor NTP (URL/IP, máx. 32 caracteres)', pl: 'Serwer NTP (URL/IP, maks. 32 znaki)', uk: 'NTP-сервер (URL/IP, макс. 32 символи)', 'zh-cn': 'NTP 服务器（URL/IP，最多 32 个字符）' },
        'Netzwerk': { en: 'Network', de: 'Netzwerk', ru: 'Сеть', pt: 'Rede', nl: 'Netwerk', fr: 'Réseau', it: 'Rete', es: 'Red', pl: 'Sieć', uk: 'Мережа', 'zh-cn': '网络' },
        'Neustart': { en: 'Restart', de: 'Neustart', ru: 'Перезапуск', pt: 'Reiniciar', nl: 'Herstarten', fr: 'Redémarrer', it: 'Riavvio', es: 'Reiniciar', pl: 'Restart', uk: 'Перезапуск', 'zh-cn': '重启' },
        'RFC1123 Zeitstempel (muss GMT sein)': { en: 'RFC1123 timestamp (must be GMT)', de: 'RFC1123 Zeitstempel (muss GMT sein)', ru: 'Метка времени RFC1123 (должна быть GMT)', pt: 'Timestamp RFC1123 (deve ser GMT)', nl: 'RFC1123-tijdstempel (moet GMT zijn)', fr: 'Horodatage RFC1123 (doit être GMT)', it: 'Timestamp RFC1123 (deve essere GMT)', es: 'Marca de tiempo RFC1123 (debe ser GMT)', pl: 'Znacznik czasu RFC1123 (musi być GMT)', uk: 'Мітка часу RFC1123 (має бути GMT)', 'zh-cn': 'RFC1123 时间戳（必须为 GMT）' },
        'Sammelbefehle': { en: 'Collective commands', de: 'Sammelbefehle', ru: 'Групповые команды', pt: 'Comandos coletivos', nl: 'Verzamelcommando\'s', fr: 'Commandes groupées', it: 'Comandi collettivi', es: 'Comandos colectivos', pl: 'Polecenia zbiorcze', uk: 'Групові команди', 'zh-cn': '集合命令' },
        'Schätzung setzen OHNE Fahrt (z.B. nach manueller Bedienung am Wandtaster): aktuellen Ist-Zustand in % eintragen': { en: 'Set the estimate WITHOUT moving (e.g. after manual operation at the wall switch): enter the current actual state in %', de: 'Schätzung setzen OHNE Fahrt (z.B. nach manueller Bedienung am Wandtaster): aktuellen Ist-Zustand in % eintragen', ru: 'Установить оценку БЕЗ движения (напр. после ручного управления настенным выключателем): ввести текущее фактическое состояние в %', pt: 'Definir a estimativa SEM movimento (p.ex. após operação manual no interruptor de parede): introduzir o estado atual em %', nl: 'Schatting instellen ZONDER beweging (bijv. na handmatige bediening op de wandschakelaar): huidige werkelijke status in % invoeren', fr: 'Définir l\'estimation SANS mouvement (p.ex. après commande manuelle sur l\'interrupteur mural) : saisir l\'état réel actuel en %', it: 'Imposta la stima SENZA movimento (es. dopo comando manuale sul pulsante a muro): inserire lo stato attuale in %', es: 'Definir la estimación SIN movimiento (p.ej. tras el manejo manual en el interruptor de pared): introducir el estado actual en %', pl: 'Ustaw szacunek BEZ ruchu (np. po ręcznej obsłudze przełącznika ściennego): wpisz aktualny stan rzeczywisty w %', uk: 'Встановити оцінку БЕЗ руху (напр. після ручного керування настінним вимикачем): ввести поточний фактичний стан у %', 'zh-cn': '设置估计值但不移动（例如手动操作墙壁开关后）：输入当前实际状态百分比' },
        'Seriennummer': { en: 'Serial number', de: 'Seriennummer', ru: 'Серийный номер', pt: 'Número de série', nl: 'Serienummer', fr: 'Numéro de série', it: 'Numero di serie', es: 'Número de serie', pl: 'Numer seryjny', uk: 'Серійний номер', 'zh-cn': '序列号' },
        'Signalstärke': { en: 'Signal strength', de: 'Signalstärke', ru: 'Мощность сигнала', pt: 'Força do sinal', nl: 'Signaalsterkte', fr: 'Force du signal', it: 'Potenza del segnale', es: 'Intensidad de la señal', pl: 'Siła sygnału', uk: 'Потужність сигналу', 'zh-cn': '信号强度' },
        'Smartfront': { en: 'Smartfront', de: 'Smartfront', ru: 'Smartfront', pt: 'Smartfront', nl: 'Smartfront', fr: 'Smartfront', it: 'Smartfront', es: 'Smartfront', pl: 'Smartfront', uk: 'Smartfront', 'zh-cn': 'Smartfront' },
        'Software-Version': { en: 'Software version', de: 'Software-Version', ru: 'Версия ПО', pt: 'Versão do software', nl: 'Softwareversie', fr: 'Version logicielle', it: 'Versione software', es: 'Versión de software', pl: 'Wersja oprogramowania', uk: 'Версія ПЗ', 'zh-cn': '软件版本' },
        'Sommerzeit-Offset HHMM': { en: 'Daylight saving offset HHMM', de: 'Sommerzeit-Offset HHMM', ru: 'Смещение летнего времени HHMM', pt: 'Offset de horário de verão HHMM', nl: 'Zomertijd-offset HHMM', fr: 'Décalage heure d\'été HHMM', it: 'Offset ora legale HHMM', es: 'Desfase de horario de verano HHMM', pl: 'Przesunięcie czasu letniego HHMM', uk: 'Зміщення літнього часу HHMM', 'zh-cn': '夏令时偏移 HHMM' },
        'Standort': { en: 'Location', de: 'Standort', ru: 'Местоположение', pt: 'Localização', nl: 'Locatie', fr: 'Emplacement', it: 'Posizione', es: 'Ubicación', pl: 'Lokalizacja', uk: 'Розташування', 'zh-cn': '位置' },
        'Standortbezeichnung (frei wählbar, z.B. "Fideris Valzigg")': { en: 'Location label (freely choosable, e.g. "Fideris Valzigg")', de: 'Standortbezeichnung (frei wählbar, z.B. "Fideris Valzigg")', ru: 'Обозначение местоположения (произвольное, напр. "Fideris Valzigg")', pt: 'Designação da localização (livremente escolhível, p.ex. "Fideris Valzigg")', nl: 'Locatieomschrijving (vrij te kiezen, bijv. "Fideris Valzigg")', fr: 'Nom de l\'emplacement (libre, p.ex. "Fideris Valzigg")', it: 'Descrizione della posizione (a scelta libera, es. "Fideris Valzigg")', es: 'Nombre de la ubicación (libre, p.ej. "Fideris Valzigg")', pl: 'Nazwa lokalizacji (dowolna, np. "Fideris Valzigg")', uk: 'Позначення розташування (довільне, напр. "Fideris Valzigg")', 'zh-cn': '位置名称（可自定义，例如 "Fideris Valzigg"）' },
        'Statische Infos neu laden (id/net/chdes)': { en: 'Reload static info (id/net/chdes)', de: 'Statische Infos neu laden (id/net/chdes)', ru: 'Перезагрузить статическую информацию (id/net/chdes)', pt: 'Recarregar informação estática (id/net/chdes)', nl: 'Statische info opnieuw laden (id/net/chdes)', fr: 'Recharger les infos statiques (id/net/chdes)', it: 'Ricarica informazioni statiche (id/net/chdes)', es: 'Recargar información estática (id/net/chdes)', pl: 'Odśwież informacje statyczne (id/net/chdes)', uk: 'Перезавантажити статичну інформацію (id/net/chdes)', 'zh-cn': '重新加载静态信息 (id/net/chdes)' },
        'System-Name': { en: 'System name', de: 'System-Name', ru: 'Имя системы', pt: 'Nome do sistema', nl: 'Systeemnaam', fr: 'Nom du système', it: 'Nome del sistema', es: 'Nombre del sistema', pl: 'Nazwa systemu', uk: 'Ім\'я системи', 'zh-cn': '系统名称' },
        'Systembefehle': { en: 'System commands', de: 'Systembefehle', ru: 'Системные команды', pt: 'Comandos do sistema', nl: 'Systeemcommando\'s', fr: 'Commandes système', it: 'Comandi di sistema', es: 'Comandos del sistema', pl: 'Polecenia systemowe', uk: 'Системні команди', 'zh-cn': '系统命令' },
        'Temperatur': { en: 'Temperature', de: 'Temperatur', ru: 'Температура', pt: 'Temperatura', nl: 'Temperatuur', fr: 'Température', it: 'Temperatura', es: 'Temperatura', pl: 'Temperatura', uk: 'Температура', 'zh-cn': '温度' },
        'Typ-Code (chdes)': { en: 'Type code (chdes)', de: 'Typ-Code (chdes)', ru: 'Код типа (chdes)', pt: 'Código de tipo (chdes)', nl: 'Typecode (chdes)', fr: 'Code de type (chdes)', it: 'Codice tipo (chdes)', es: 'Código de tipo (chdes)', pl: 'Kod typu (chdes)', uk: 'Код типу (chdes)', 'zh-cn': '类型代码 (chdes)' },
        'Verbindung OK': {
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
        'Zeitzonen-Offset HHMM (z.B. +0200)': { en: 'Timezone offset HHMM (e.g. +0200)', de: 'Zeitzonen-Offset HHMM (z.B. +0200)', ru: 'Смещение часового пояса HHMM (напр. +0200)', pt: 'Offset de fuso horário HHMM (p.ex. +0200)', nl: 'Tijdzone-offset HHMM (bijv. +0200)', fr: 'Décalage de fuseau horaire HHMM (p.ex. +0200)', it: 'Offset fuso orario HHMM (es. +0200)', es: 'Desfase horario HHMM (p.ej. +0200)', pl: 'Przesunięcie strefy czasowej HHMM (np. +0200)', uk: 'Зміщення часового поясу HHMM (напр. +0200)', 'zh-cn': '时区偏移 HHMM（例如 +0200）' },
        'Zurück in Access-Point-Modus (Konfiguration bleibt erhalten)': { en: 'Back to access point mode (configuration is retained)', de: 'Zurück in Access-Point-Modus (Konfiguration bleibt erhalten)', ru: 'Вернуться в режим точки доступа (конфигурация сохраняется)', pt: 'Voltar ao modo ponto de acesso (a configuração é mantida)', nl: 'Terug naar access point-modus (configuratie blijft behouden)', fr: 'Retour en mode point d\'accès (la configuration est conservée)', it: 'Torna alla modalità access point (la configurazione viene mantenuta)', es: 'Volver al modo punto de acceso (se conserva la configuración)', pl: 'Powrót do trybu punktu dostępu (konfiguracja zostaje zachowana)', uk: 'Повернутися в режим точки доступу (конфігурація зберігається)', 'zh-cn': '返回接入点模式（保留配置）' },
        'Zustand (0-100, bei Storen meist -1=unbekannt)': { en: 'State (0-100, for shutters usually -1=unknown)', de: 'Zustand (0-100, bei Storen meist -1=unbekannt)', ru: 'Состояние (0-100, для жалюзи обычно -1=неизвестно)', pt: 'Estado (0-100, em estores geralmente -1=desconhecido)', nl: 'Status (0-100, bij zonwering meestal -1=onbekend)', fr: 'État (0-100, pour les stores généralement -1=inconnu)', it: 'Stato (0-100, per le tapparelle solitamente -1=sconosciuto)', es: 'Estado (0-100, en persianas normalmente -1=desconocido)', pl: 'Stan (0-100, dla rolet zwykle -1=nieznany)', uk: 'Стан (0-100, для жалюзі зазвичай -1=невідомо)', 'zh-cn': '状态 (0-100，卷帘通常 -1=未知)' },
        'Stopp': { en: 'Stop', de: 'Stopp', ru: 'Стоп', pt: 'Parar', nl: 'Stop', fr: 'Arrêt', it: 'Stop', es: 'Detener', pl: 'Stop', uk: 'Стоп', 'zh-cn': '停止' },
        'Ein (100%)': { en: 'On (100%)', de: 'Ein (100%)', ru: 'Вкл (100%)', pt: 'Ligado (100%)', nl: 'Aan (100%)', fr: 'Marche (100%)', it: 'Acceso (100%)', es: 'Encendido (100%)', pl: 'Wł. (100%)', uk: 'Увімк (100%)', 'zh-cn': '开 (100%)' },
        'Aus (0%)': { en: 'Off (0%)', de: 'Aus (0%)', ru: 'Выкл (0%)', pt: 'Desligado (0%)', nl: 'Uit (0%)', fr: 'Arrêt (0%)', it: 'Spento (0%)', es: 'Apagado (0%)', pl: 'Wył. (0%)', uk: 'Вимк (0%)', 'zh-cn': '关 (0%)' },
        'Umschalten': { en: 'Toggle', de: 'Umschalten', ru: 'Переключить', pt: 'Alternar', nl: 'Omschakelen', fr: 'Basculer', it: 'Commuta', es: 'Alternar', pl: 'Przełącz', uk: 'Перемкнути', 'zh-cn': '切换' },
        'Öffnen': { en: 'Open', de: 'Öffnen', ru: 'Открыть', pt: 'Abrir', nl: 'Openen', fr: 'Ouvrir', it: 'Apri', es: 'Abrir', pl: 'Otwórz', uk: 'Відкрити', 'zh-cn': '打开' },
        'Schliessen': { en: 'Close', de: 'Schliessen', ru: 'Закрыть', pt: 'Fechar', nl: 'Sluiten', fr: 'Fermer', it: 'Chiudi', es: 'Cerrar', pl: 'Zamknij', uk: 'Закрити', 'zh-cn': '关闭' },
        'Öffnen (Taste halten)': { en: 'Open (hold button)', de: 'Öffnen (Taste halten)', ru: 'Открыть (удерж. кнопку)', pt: 'Abrir (manter botão)', nl: 'Openen (knop ingedrukt houden)', fr: 'Ouvrir (maintenir le bouton)', it: 'Apri (tieni premuto)', es: 'Abrir (mantener pulsado)', pl: 'Otwórz (przytrzymaj przycisk)', uk: 'Відкрити (утримувати кнопку)', 'zh-cn': '打开（长按按钮）' },
        'Schliessen (Taste halten)': { en: 'Close (hold button)', de: 'Schliessen (Taste halten)', ru: 'Закрыть (удерж. кнопку)', pt: 'Fechar (manter botão)', nl: 'Sluiten (knop ingedrukt houden)', fr: 'Fermer (maintenir le bouton)', it: 'Chiudi (tieni premuto)', es: 'Cerrar (mantener pulsado)', pl: 'Zamknij (przytrzymaj przycisk)', uk: 'Закрити (утримувати кнопку)', 'zh-cn': '关闭（长按按钮）' },
        'Dimmen hoch (Taste halten)': { en: 'Dim up (hold button)', de: 'Dimmen hoch (Taste halten)', ru: 'Увеличить яркость (удерж. кнопку)', pt: 'Aumentar luminosidade (manter botão)', nl: 'Dimmen omhoog (knop ingedrukt houden)', fr: 'Augmenter la lumière (maintenir le bouton)', it: 'Aumenta luminosità (tieni premuto)', es: 'Aumentar brillo (mantener pulsado)', pl: 'Rozjaśnij (przytrzymaj przycisk)', uk: 'Збільшити яскравість (утримувати кнопку)', 'zh-cn': '调亮（长按按钮）' },
        'Dimmen runter (Taste halten)': { en: 'Dim down (hold button)', de: 'Dimmen runter (Taste halten)', ru: 'Уменьшить яркость (удерж. кнопку)', pt: 'Diminuir luminosidade (manter botão)', nl: 'Dimmen omlaag (knop ingedrukt houden)', fr: 'Diminuer la lumière (maintenir le bouton)', it: 'Diminuisci luminosità (tieni premuto)', es: 'Disminuir brillo (mantener pulsado)', pl: 'Przyciemnij (przytrzymaj przycisk)', uk: 'Зменшити яскравість (утримувати кнопку)', 'zh-cn': '调暗（长按按钮）' },
        'SSID': { en: 'SSID', de: 'SSID', ru: 'SSID', pt: 'SSID', nl: 'SSID', fr: 'SSID', it: 'SSID', es: 'SSID', pl: 'SSID', uk: 'SSID', 'zh-cn': 'SSID' },
        'IP-Adresse': { en: 'IP address', de: 'IP-Adresse', ru: 'IP-адрес', pt: 'Endereço IP', nl: 'IP-adres', fr: 'Adresse IP', it: 'Indirizzo IP', es: 'Dirección IP', pl: 'Adres IP', uk: 'IP-адреса', 'zh-cn': 'IP 地址' },
        'MAC-Adresse': { en: 'MAC address', de: 'MAC-Adresse', ru: 'MAC-адрес', pt: 'Endereço MAC', nl: 'MAC-adres', fr: 'Adresse MAC', it: 'Indirizzo MAC', es: 'Dirección MAC', pl: 'Adres MAC', uk: 'MAC-адреса', 'zh-cn': 'MAC 地址' },
        'Netzwerkmodus (0=AccessPoint, 1=Associate)': { en: 'Network mode (0=AccessPoint, 1=Associate)', de: 'Netzwerkmodus (0=AccessPoint, 1=Associate)', ru: 'Режим сети (0=точка доступа, 1=подключение)', pt: 'Modo de rede (0=Ponto de Acesso, 1=Associar)', nl: 'Netwerkmodus (0=AccessPoint, 1=Associate)', fr: 'Mode réseau (0=point d\'accès, 1=associé)', it: 'Modalità di rete (0=Access Point, 1=Associato)', es: 'Modo de red (0=Punto de acceso, 1=Asociado)', pl: 'Tryb sieci (0=punkt dostępu, 1=powiązanie)', uk: 'Режим мережі (0=точка доступу, 1=підключення)', 'zh-cn': '网络模式 (0=接入点, 1=关联)' },
        'Verschlüsselung': { en: 'Encryption', de: 'Verschlüsselung', ru: 'Шифрование', pt: 'Encriptação', nl: 'Versleuteling', fr: 'Chiffrement', it: 'Crittografia', es: 'Cifrado', pl: 'Szyfrowanie', uk: 'Шифрування', 'zh-cn': '加密' },
        'Subnetzmaske': { en: 'Subnet mask', de: 'Subnetzmaske', ru: 'Маска подсети', pt: 'Máscara de sub-rede', nl: 'Subnetmasker', fr: 'Masque de sous-réseau', it: 'Maschera di sottorete', es: 'Máscara de subred', pl: 'Maska podsieci', uk: 'Маска підмережі', 'zh-cn': '子网掩码' },
        'Gateway': { en: 'Gateway', de: 'Gateway', ru: 'Шлюз', pt: 'Gateway', nl: 'Gateway', fr: 'Passerelle', it: 'Gateway', es: 'Puerta de enlace', pl: 'Brama', uk: 'Шлюз', 'zh-cn': '网关' },
        'MAC-Adresse Access Point': { en: 'MAC address access point', de: 'MAC-Adresse Access Point', ru: 'MAC-адрес точки доступа', pt: 'Endereço MAC do ponto de acesso', nl: 'MAC-adres access point', fr: 'Adresse MAC du point d\'accès', it: 'Indirizzo MAC access point', es: 'Dirección MAC del punto de acceso', pl: 'Adres MAC punktu dostępu', uk: 'MAC-адреса точки доступу', 'zh-cn': '接入点 MAC 地址' },
        'Geschätzte Ist-Position 0=zu/100=offen (reine Anzeige der Software-Schätzung, KEINE Hardware-Rückmeldung; zum Kalibrieren "calibrate" verwenden, zum Anfahren "setPosition")': { en: 'Estimated actual position 0=closed/100=open (software estimate display only, NO hardware feedback; use "calibrate" to calibrate, "setPosition" to move)', de: 'Geschätzte Ist-Position 0=zu/100=offen (reine Anzeige der Software-Schätzung, KEINE Hardware-Rückmeldung; zum Kalibrieren "calibrate" verwenden, zum Anfahren "setPosition")', ru: 'Расчётная текущая позиция 0=закрыто/100=открыто (только программная оценка, БЕЗ обратной связи от оборудования; для калибровки используйте "calibrate", для перемещения "setPosition")', pt: 'Posição atual estimada 0=fechado/100=aberto (apenas exibição de estimativa por software, SEM feedback de hardware; use "calibrate" para calibrar, "setPosition" para mover)', nl: 'Geschatte werkelijke positie 0=dicht/100=open (alleen software-schatting, GEEN hardware-terugkoppeling; gebruik "calibrate" om te kalibreren, "setPosition" om te bewegen)', fr: 'Position réelle estimée 0=fermé/100=ouvert (affichage logiciel uniquement, PAS de retour matériel ; utiliser "calibrate" pour calibrer, "setPosition" pour déplacer)', it: 'Posizione effettiva stimata 0=chiuso/100=aperto (solo visualizzazione stima software, NESSUN feedback hardware; usare "calibrate" per calibrare, "setPosition" per muovere)', es: 'Posición real estimada 0=cerrado/100=abierto (solo visualización de estimación por software, SIN retroalimentación de hardware; usar "calibrate" para calibrar, "setPosition" para mover)', pl: 'Szacowana pozycja rzeczywista 0=zamknięte/100=otwarte (tylko wyświetlanie szacunku programowego, BRAK sprzężenia zwrotnego sprzętu; użyj "calibrate" do kalibracji, "setPosition" do przesunięcia)', uk: 'Розрахункова фактична позиція 0=закрито/100=відкрито (лише програмна оцінка, БЕЗ апаратного зворотного зв\'язку; для калібрування використовуйте "calibrate", для переміщення "setPosition")', 'zh-cn': '估计的实际位置 0=关闭/100=打开（仅软件估算显示，无硬件反馈；使用 "calibrate" 校准，"setPosition" 移动）' },
        'Geschätzte Position (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)': { en: 'Estimated position (disabled - set "Shutter motor runtime" to >0s)', de: 'Geschätzte Position (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)', ru: 'Расчётная позиция (отключено - установите "Время работы мотора жалюзи" > 0с)', pt: 'Posição estimada (desativado - definir "Tempo de funcionamento do motor" para >0s)', nl: 'Geschatte positie (uitgeschakeld - "Looptijd zonweringmotor" op >0s zetten)', fr: 'Position estimée (désactivé - régler "Durée du moteur de store" sur >0s)', it: 'Posizione stimata (disattivato - impostare "Tempo di funzionamento motore tapparella" su >0s)', es: 'Posición estimada (desactivado - establecer "Tiempo de funcionamiento del motor de persiana" a >0s)', pl: 'Szacowana pozycja (wyłączone - ustaw "Czas pracy silnika rolety" na >0s)', uk: 'Розрахункова позиція (вимкнено - встановіть "Час роботи двигуна жалюзі" > 0с)', 'zh-cn': '估计位置（已禁用 - 将"卷帘电机运行时间"设置为大于0秒）' },
        'Position anfahren 0=zu/100=offen (zeitbasiert über move-Impulse; 0/100 fahren als echte Endlagenfahrt und rekalibrieren die Schätzung)': { en: 'Move to position 0=closed/100=open (time-based via move pulses; 0/100 run as a real end-limit run and recalibrate the estimate)', de: 'Position anfahren 0=zu/100=offen (zeitbasiert über move-Impulse; 0/100 fahren als echte Endlagenfahrt und rekalibrieren die Schätzung)', ru: 'Переместить в позицию 0=закрыто/100=открыто (по времени через импульсы move; 0/100 выполняются как реальный ход до концевого положения и перекалибровка оценки)', pt: 'Mover para a posição 0=fechado/100=aberto (baseado em tempo via impulsos move; 0/100 executam como percurso real até ao fim de curso e recalibram a estimativa)', nl: 'Naar positie bewegen 0=dicht/100=open (tijdgebaseerd via move-pulsen; 0/100 rijden als echte eindpositierit en herkalibreren de schatting)', fr: 'Déplacer vers la position 0=fermé/100=ouvert (basé sur le temps via des impulsions move ; 0/100 effectuent une vraie course en fin de course et recalibrent l\'estimation)', it: 'Sposta in posizione 0=chiuso/100=aperto (basato sul tempo tramite impulsi move; 0/100 eseguono una vera corsa di fine corsa e ricalibrano la stima)', es: 'Mover a la posición 0=cerrado/100=abierto (basado en tiempo mediante impulsos move; 0/100 se ejecutan como una carrera real hasta el final de recorrido y recalibran la estimación)', pl: 'Przesuń do pozycji 0=zamknięte/100=otwarte (oparte na czasie za pomocą impulsów move; 0/100 wykonują rzeczywisty przebieg do położenia krańcowego i rekalibrują szacunek)', uk: 'Перемістити в позицію 0=закрито/100=відкрито (за часом через імпульси move; 0/100 виконуються як реальний хід до кінцевого положення та перекалібровують оцінку)', 'zh-cn': '移动到位置 0=关闭/100=打开（通过 move 脉冲按时间计算；0/100 作为真实限位行程运行并重新校准估算值）' },
        'Position anfahren (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)': { en: 'Move to position (disabled - set "Shutter motor runtime" to >0s)', de: 'Position anfahren (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)', ru: 'Переместить в позицию (отключено - установите "Время работы мотора жалюзи" > 0с)', pt: 'Mover para a posição (desativado - definir "Tempo de funcionamento do motor" para >0s)', nl: 'Naar positie bewegen (uitgeschakeld - "Looptijd zonweringmotor" op >0s zetten)', fr: 'Déplacer vers la position (désactivé - régler "Durée du moteur de store" sur >0s)', it: 'Sposta in posizione (disattivato - impostare "Tempo di funzionamento motore tapparella" su >0s)', es: 'Mover a la posición (desactivado - establecer "Tiempo de funcionamiento del motor de persiana" a >0s)', pl: 'Przesuń do pozycji (wyłączone - ustaw "Czas pracy silnika rolety" na >0s)', uk: 'Перемістити в позицію (вимкнено - встановіть "Час роботи двигуна жалюзі" > 0с)', 'zh-cn': '移动到位置（已禁用 - 将"卷帘电机运行时间"设置为大于0秒）' },
        'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)': { en: 'Tilt slats (disabled - set "Tilt pulse (ms)" in the configuration)', de: 'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)', ru: 'Наклонить ламели (отключено - установите "Импульс наклона (мс)" в конфигурации)', pt: 'Inclinar réguas (desativado - definir "Impulso de inclinação (ms)" na configuração)', nl: 'Lamellen kantelen (uitgeschakeld - "Kantelpuls (ms)" in de configuratie instellen)', fr: 'Incliner les lamelles (désactivé - régler "Impulsion d\'inclinaison (ms)" dans la configuration)', it: 'Inclina lamelle (disattivato - impostare "Impulso di inclinazione (ms)" nella configurazione)', es: 'Inclinar lamas (desactivado - establecer "Impulso de inclinación (ms)" en la configuración)', pl: 'Przechyl lamele (wyłączone - ustaw "Impuls przechyłu (ms)" w konfiguracji)', uk: 'Нахилити ламелі (вимкнено - встановіть "Імпульс нахилу (мс)" у конфігурації)', 'zh-cn': '倾斜叶片（已禁用 - 请在配置中设置"倾斜脉冲（毫秒）"）' }
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
                if (!obj || (obj.type !== 'state' && obj.type !== 'channel') || !obj.common) {
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
                } else if (
                    (id === 'info.connection' || /^[^.]+\.\d+\.info\.connection$/.test(id)) &&
                    obj.common.name &&
                    typeof obj.common.name === 'object' &&
                    !obj.common.name.ru
                ) {
                    // The global (adapter-level, not per-device) info.connection instanceObject:
                    // io-package.json has the full translation since 1.0.1, but instanceObjects are
                    // only synced by js-controller on certain update paths (e.g. 'iobroker upgrade')
                    // - not reliably when installing via 'iobroker url', which some users do. Force
                    // it here too so it doesn't depend on that.
                    await this.extendObjectAsync(id, {
                        common: {
                            name: {
                                en: 'At least one device reachable',
                                de: 'Mindestens ein Gerät erreichbar',
                                ru: 'Доступно хотя бы одно устройство',
                                pt: 'Pelo menos um dispositivo acessível',
                                nl: 'Ten minste één apparaat bereikbaar',
                                fr: 'Au moins un appareil accessible',
                                it: 'Almeno un dispositivo raggiungibile',
                                es: 'Al menos un dispositivo accesible',
                                pl: 'Co najmniej jedno urządzenie dostępne',
                                uk: 'Принаймні один пристрій доступний',
                                'zh-cn': '至少有一个设备可访问'
                            }
                        }
                    });
                    fixedCount++;
                }

                // Name migration (added 1.0.8): plain-string common.name from a version <1.0.8
                // -> full 11-language i18n object. Independent of the role-fix chain above, so it
                // runs for every object regardless of whether a role fix also applied.
                if (typeof obj.common.name === 'string') {
                    const mapped = NAME_MIGRATION_MAP[obj.common.name];
                    if (mapped) {
                        await this.extendObjectAsync(id, { common: { name: mapped } });
                        fixedCount++;
                    } else {
                        // Dynamic scene button names: "Szene 1 abrufen" / "... speichern" / "... löschen"
                        const sceneMatch = obj.common.name.match(/^Szene (\d+) (abrufen|speichern|löschen)$/);
                        if (sceneMatch) {
                            const [, num, verbDe] = sceneMatch;
                            const verbMap = {
                                abrufen: { en: 'recall', de: 'abrufen', ru: 'вызвать', pt: 'chamar', nl: 'oproepen', fr: 'rappeler', it: 'richiama', es: 'recuperar', pl: 'przywołaj', uk: 'викликати', 'zh-cn': '调用' },
                                speichern: { en: 'store', de: 'speichern', ru: 'сохранить', pt: 'guardar', nl: 'opslaan', fr: 'enregistrer', it: 'salva', es: 'guardar', pl: 'zapisz', uk: 'зберегти', 'zh-cn': '保存' },
                                'löschen': { en: 'delete', de: 'löschen', ru: 'удалить', pt: 'eliminar', nl: 'verwijderen', fr: 'supprimer', it: 'elimina', es: 'eliminar', pl: 'usuń', uk: 'видалити', 'zh-cn': '删除' }
                            };
                            const verb = verbMap[verbDe];
                            if (verb) {
                                await this.extendObjectAsync(id, { common: { name: {
                                    en: `Scene ${num} ${verb.en}`, de: `Szene ${num} ${verb.de}`, ru: `Сцена ${num}: ${verb.ru}`,
                                    pt: `Cena ${num} ${verb.pt}`, nl: `Scène ${num} ${verb.nl}`, fr: `Scène ${num} ${verb.fr}`,
                                    it: `Scena ${num} ${verb.it}`, es: `Escena ${num} ${verb.es}`, pl: `Scena ${num}: ${verb.pl}`,
                                    uk: `Сцена ${num}: ${verb.uk}`, 'zh-cn': `场景 ${num} ${verb['zh-cn']}`
                                } } });
                                fixedCount++;
                            }
                        } else {
                            // Dynamic tilt names: "Lamellen kippen Richtung offen/zu (Impuls Nms)"
                            const tiltMatch = obj.common.name.match(/^Lamellen kippen Richtung (offen|zu) \(Impuls (\d+)ms\)$/);
                            if (tiltMatch) {
                                const [, dirDe, ms] = tiltMatch;
                                if (dirDe === 'offen') {
                                    await this.extendObjectAsync(id, { common: { name: {
                                        en: `Tilt slats open (pulse ${ms}ms)`, de: `Lamellen kippen Richtung offen (Impuls ${ms}ms)`, ru: `Наклонить ламели открыто (импульс ${ms}мс)`, pt: `Inclinar réguas para abrir (impulso ${ms}ms)`, nl: `Lamellen kantelen richting open (puls ${ms}ms)`, fr: `Incliner les lamelles vers l'ouverture (impulsion ${ms}ms)`, it: `Inclina lamelle verso apertura (impulso ${ms}ms)`, es: `Inclinar lamas hacia abierto (impulso ${ms}ms)`, pl: `Przechyl lamele w kierunku otwarcia (impuls ${ms}ms)`, uk: `Нахилити ламелі відкрито (імпульс ${ms}мс)`, 'zh-cn': `叶片向开启方向倾斜（脉冲 ${ms}毫秒）`
                                    } } });
                                } else {
                                    await this.extendObjectAsync(id, { common: { name: {
                                        en: `Tilt slats closed (pulse ${ms}ms)`, de: `Lamellen kippen Richtung zu (Impuls ${ms}ms)`, ru: `Наклонить ламели закрыто (импульс ${ms}мс)`, pt: `Inclinar réguas para fechar (impulso ${ms}ms)`, nl: `Lamellen kantelen richting dicht (puls ${ms}ms)`, fr: `Incliner les lamelles vers la fermeture (impulsion ${ms}ms)`, it: `Inclina lamelle verso chiusura (impulso ${ms}ms)`, es: `Inclinar lamas hacia cerrado (impulso ${ms}ms)`, pl: `Przechyl lamele w kierunku zamknięcia (impuls ${ms}ms)`, uk: `Нахилити ламелі закрито (імпульс ${ms}мс)`, 'zh-cn': `叶片向关闭方向倾斜（脉冲 ${ms}毫秒）`
                                    } } });
                                }
                                fixedCount++;
                            }
                        }
                    }
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
        // Initializes the runtime message-translation system (i18n/*.json) - reads the ioBroker
        // system language from system.config.common.language automatically. Used for onMessage()
        // result text (CSV import report, device test, discovery summary) shown in the admin
        // dialog, so German UI users get German results while everyone else gets English or their
        // own configured language, per maintainer requirement (all user-facing text must be
        // English or full i18n - not always German regardless of the system language).
        await I18n.init(__dirname, this);

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
                this.log.info(`Device ID auto-assigned: "${candidate}" for host ${d.host}`);
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
            if (seenIds.has(sanId)) errs.push({ key: 'validateIdDuplicate', args: [d.id, sanId] });
            const hostKey = String(d.host).trim().toLowerCase();
            if (seenHosts.has(hostKey)) errs.push({ key: 'validateHostDuplicate', args: [d.host] });
            if (errs.length) {
                this.log.error(`Device "${d.name || d.id || d.host}" skipped: ${this.renderValidationErrorsEn(errs)}`);
                continue;
            }
            seenIds.add(sanId);
            seenHosts.add(hostKey);
            validated.push(d);
        }

        if (!validated.length && active.length) {
            this.log.error('All configured devices are invalid - please check the configuration (use the Test button).');
        }

        // --- Paralleles Setup ---
        // Sequentielles await würde bei vielen (teils offline) Geräten den Start
        // minutenlang blockieren (jedes Gerät macht mehrere HTTP-Calls mit Timeout).
        await Promise.allSettled(validated.map(async (dev) => {
            try {
                await this.setupDevice(dev);
            } catch (err) {
                this.log.error(`Device ${dev.id} could not be initialized: ${err.message || err}`);
            }
        }));

        // Verwaiste Geräte-Objekte entfernen: alles unter zeptrion.N.<deviceId>, dessen
        // <deviceId> nicht (mehr) in der aktiven Konfiguration steht, wird gelöscht.
        // Verhindert, dass States gelöschter/umbenannter Geräte im Objektbaum liegen
        // bleiben (Bug: alte Zustände blieben nach Entfernen/Ersetzen eines Geräts).
        await this.cleanupOrphanedDevices(validated);

        if (!active.length) {
            this.log.warn('No active zeptrion devices configured. Please add devices in the instance configuration or use the Discovery button.');
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
                    this.log.info(`Removing orphaned device "${devId}" (no longer in the configuration).`);
                    await this.delObjectAsync(devId, { recursive: true });
                }
            }
        } catch (err) {
            this.log.warn(`Cleanup of orphaned objects failed: ${err.message || err}`);
        }
    }

    /** Validiert eine Geräte-Zeile aus der Konfiguration/dem CSV-Import. Gibt eine
     * Liste menschenlesbarer Fehler zurück (leer = gültig). */
    // Field-validation templates, always in English regardless of the current I18n language -
    // used exclusively for this.log.*() output, which must stay English per the adapter checklist.
    // Keys match the corresponding entries in i18n/<lang>.json used for the localized UI path
    // (CSV import report) - see validateDeviceRow()/renderValidationErrorsEn()/renderValidationErrorsLocalized().
    static VALIDATION_TEMPLATES_EN = {
        validateHostMissing: () => 'Host missing',
        validateHostInvalidChars: (host) => `Host "${host}" contains invalid characters (no http://, no spaces, no port)`,
        validateHostInvalidIPv4: (host) => `"${host}" is not a valid IPv4 address`,
        validateIdInvalidChars: (id) => `ID "${id}" contains invalid characters (allowed: a-z, 0-9, _, -)`,
        validateChannelsInvalid: (channels) => `Channels "${channels}" invalid (1-4)`,
        validateKindInvalid: (kind) => `Type "${kind}" invalid (unknown/blind/light)`,
        validateRuntimeInvalid: (t) => `Runtime "${t}" invalid (0-300s)`,
        validateRuntimePerChannelMax: (v) => `Runtime/channel "${v}" maximum 4 values`,
        validateRuntimePerChannelValueInvalid: (v, p) => `Runtime/channel "${v}": value "${p}" invalid (0-300, integer)`,
        validateTiltPulseInvalid: (t) => `Tilt pulse "${t}" invalid (0-5000ms)`,
        validatePollIntervalInvalid: (t) => `Poll interval "${t}" invalid (5-3600s)`,
        validateIdDuplicate: (id, sanId) => `ID "${id}" (sanitized "${sanId}") is assigned twice`,
        validateHostDuplicate: (host) => `Host "${host}" is configured twice`,
    };

    // Renders validateDeviceRow() entries in English only - for this.log.*() call sites.
    renderValidationErrorsEn(errs) {
        return errs.map(e => Zeptrion.VALIDATION_TEMPLATES_EN[e.key](...e.args)).join('; ');
    }

    // Renders validateDeviceRow() entries in the current adapter language - for UI-facing
    // sendTo() responses (e.g. the CSV import report).
    renderValidationErrorsLocalized(errs) {
        return errs.map(e => I18n.translate(e.key, ...e.args)).join('; ');
    }

    validateDeviceRow(d) {
        const errs = [];
        const host = String(d.host || '').trim();
        if (!host) {
            errs.push({ key: 'validateHostMissing', args: [] });
        } else if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
            errs.push({ key: 'validateHostInvalidChars', args: [host] });
        } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const octets = host.split('.').map(Number);
            if (octets.length !== 4 || octets.some(o => o < 0 || o > 255)) {
                errs.push({ key: 'validateHostInvalidIPv4', args: [host] });
            }
        }
        if (d.id && !/^[a-zA-Z0-9_-]+$/.test(String(d.id))) {
            errs.push({ key: 'validateIdInvalidChars', args: [d.id] });
        }
        const ch = parseInt(d.channels, 10);
        if (d.channels !== undefined && d.channels !== '' && (isNaN(ch) || ch < 1 || ch > 4)) {
            errs.push({ key: 'validateChannelsInvalid', args: [d.channels] });
        }
        if (d.kind !== undefined && d.kind !== '' && !['unknown', 'blind', 'light'].includes(String(d.kind))) {
            errs.push({ key: 'validateKindInvalid', args: [d.kind] });
        }
        const tt = parseInt(d.travelTimeSec, 10);
        if (d.travelTimeSec !== undefined && d.travelTimeSec !== '' && (isNaN(tt) || tt < 0 || tt > 300)) {
            errs.push({ key: 'validateRuntimeInvalid', args: [d.travelTimeSec] });
        }
        if (d.travelTimeSecCh !== undefined && String(d.travelTimeSecCh).trim() !== '') {
            const parts = String(d.travelTimeSecCh).split(',').map(s => s.trim());
            if (parts.length > 4) {
                errs.push({ key: 'validateRuntimePerChannelMax', args: [d.travelTimeSecCh] });
            }
            for (const p of parts) {
                if (p === '') continue; // leerer Eintrag = Fallback auf travelTimeSec
                const v = parseInt(p, 10);
                if (isNaN(v) || v < 0 || v > 300 || String(v) !== p) {
                    errs.push({ key: 'validateRuntimePerChannelValueInvalid', args: [d.travelTimeSecCh, p] });
                    break;
                }
            }
        }
        const tp = parseInt(d.tiltTimeMs, 10);
        if (d.tiltTimeMs !== undefined && d.tiltTimeMs !== '' && (isNaN(tp) || tp < 0 || tp > 5000)) {
            errs.push({ key: 'validateTiltPulseInvalid', args: [d.tiltTimeMs] });
        }
        const pi = parseInt(d.pollInterval, 10);
        if (d.pollInterval !== undefined && d.pollInterval !== '' && (isNaN(pi) || pi < 5 || pi > 3600)) {
            errs.push({ key: 'validatePollIntervalInvalid', args: [d.pollInterval] });
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
            common: { name: { en: 'Collective commands', de: 'Sammelbefehle', ru: 'Групповые команды', pt: 'Comandos coletivos', nl: 'Verzamelcommando\'s', fr: 'Commandes groupées', it: 'Comandi collettivi', es: 'Comandos colectivos', pl: 'Polecenia zbiorcze', uk: 'Групові команди', 'zh-cn': '集合命令' } },
            native: {}
        });
        await this.ensureState('control.closeAllShutters', {
            name: { en: 'Close ALL shutters (e.g. hail alarm)', de: 'ALLE Storen schliessen (z.B. Hagelalarm)', ru: 'Закрыть ВСЕ жалюзи (напр. градовая тревога)', pt: 'Fechar TODOS os estores (p.ex. alarme de granizo)', nl: 'ALLE zonweringen sluiten (bijv. hagelalarm)', fr: 'Fermer TOUS les stores (p.ex. alarme grêle)', it: 'Chiudi TUTTE le tapparelle (es. allarme grandine)', es: 'Cerrar TODAS las persianas (p.ej. alarma de granizo)', pl: 'Zamknij WSZYSTKIE rolety (np. alarm gradowy)', uk: 'Закрити ВСІ жалюзі (напр. градова тривога)', 'zh-cn': '关闭所有卷帘（例如冰雹警报）' },
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState('control.openAllShutters', {
            name: { en: 'Open all shutters', de: 'Alle Storen öffnen', ru: 'Открыть все жалюзи', pt: 'Abrir todos os estores', nl: 'Alle zonweringen openen', fr: 'Ouvrir tous les stores', it: 'Apri tutte le tapparelle', es: 'Abrir todas las persianas', pl: 'Otwórz wszystkie rolety', uk: 'Відкрити всі жалюзі', 'zh-cn': '打开所有卷帘' },
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState('control.stopAllShutters', {
            name: { en: 'Stop all shutters', de: 'Alle Storen stoppen', ru: 'Остановить все жалюзи', pt: 'Parar todos os estores', nl: 'Alle zonweringen stoppen', fr: 'Arrêter tous les stores', it: 'Ferma tutte le tapparelle', es: 'Detener todas las persianas', pl: 'Zatrzymaj wszystkie rolety', uk: 'Зупинити всі жалюзі', 'zh-cn': '停止所有卷帘' },
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
            this.log.warn(`Device ${id}: no host specified, skipping.`);
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
            this.log.info(`[${id}] chnotify long-poll disabled by configuration, interval polling only.`);
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
        await this.setObjectNotExistsAsync(`${id}.info`, { type: 'channel', common: { name: { en: 'Device information', de: 'Geräteinformationen', ru: 'Информация об устройстве', pt: 'Informação do dispositivo', nl: 'Apparaatinformatie', fr: 'Informations sur l\'appareil', it: 'Informazioni sul dispositivo', es: 'Información del dispositivo', pl: 'Informacje o urządzeniu', uk: 'Інформація про пристрій', 'zh-cn': '设备信息' } }, native: {} });
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
        await this.ensureState(`${id}.info.lastError`, { name: { en: 'Last error', de: 'Letzter Fehler', ru: 'Последняя ошибка', pt: 'Último erro', nl: 'Laatste fout', fr: 'Dernière erreur', it: 'Ultimo errore', es: 'Último error', pl: 'Ostatni błąd', uk: 'Остання помилка', 'zh-cn': '最近错误' }, type: 'string', role: 'text', read: true, write: false, def: '' });
        await this.ensureState(`${id}.info.hw`, { name: { en: 'Hardware version', de: 'Hardware-Version', ru: 'Версия оборудования', pt: 'Versão do hardware', nl: 'Hardwareversie', fr: 'Version matérielle', it: 'Versione hardware', es: 'Versión de hardware', pl: 'Wersja sprzętu', uk: 'Версія обладнання', 'zh-cn': '硬件版本' }, type: 'string', role: 'info.hardware', read: true, write: false });
        await this.ensureState(`${id}.info.sw`, { name: { en: 'Software version', de: 'Software-Version', ru: 'Версия ПО', pt: 'Versão do software', nl: 'Softwareversie', fr: 'Version logicielle', it: 'Versione software', es: 'Versión de software', pl: 'Wersja oprogramowania', uk: 'Версія ПЗ', 'zh-cn': '软件版本' }, type: 'string', role: 'info.firmware', read: true, write: false });
        await this.ensureState(`${id}.info.boot`, { name: { en: 'Bootloader version', de: 'Bootloader-Version', ru: 'Версия загрузчика', pt: 'Versão do bootloader', nl: 'Bootloaderversie', fr: 'Version du bootloader', it: 'Versione bootloader', es: 'Versión del bootloader', pl: 'Wersja bootloadera', uk: 'Версія завантажувача', 'zh-cn': '引导程序版本' }, type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.sn`, { name: { en: 'Serial number', de: 'Seriennummer', ru: 'Серийный номер', pt: 'Número de série', nl: 'Serienummer', fr: 'Numéro de série', it: 'Numero di serie', es: 'Número de serie', pl: 'Numer seryjny', uk: 'Серійний номер', 'zh-cn': '序列号' }, type: 'string', role: 'info.serial', read: true, write: false });
        await this.ensureState(`${id}.info.sys`, { name: { en: 'System name', de: 'System-Name', ru: 'Имя системы', pt: 'Nome do sistema', nl: 'Systeemnaam', fr: 'Nom du système', it: 'Nome del sistema', es: 'Nombre del sistema', pl: 'Nazwa systemu', uk: 'Ім\'я системи', 'zh-cn': '系统名称' }, type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.type`, { name: { en: 'Device type (Device ID)', de: 'Gerätetyp (Device ID)', ru: 'Тип устройства (Device ID)', pt: 'Tipo de dispositivo (Device ID)', nl: 'Apparaattype (Device ID)', fr: 'Type d\'appareil (Device ID)', it: 'Tipo di dispositivo (Device ID)', es: 'Tipo de dispositivo (Device ID)', pl: 'Typ urządzenia (Device ID)', uk: 'Тип пристрою (Device ID)', 'zh-cn': '设备类型 (Device ID)' }, type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.oen`, { name: 'Owner Environment', type: 'string', role: 'text', read: true, write: false });
        await this.ensureState(`${id}.info.rssi`, { name: { en: 'Signal strength', de: 'Signalstärke', ru: 'Мощность сигнала', pt: 'Força do sinal', nl: 'Signaalsterkte', fr: 'Force du signal', it: 'Potenza del segnale', es: 'Intensidad de la señal', pl: 'Siła sygnału', uk: 'Потужність сигналу', 'zh-cn': '信号强度' }, type: 'number', role: 'value', unit: 'dBm', read: true, write: false });
        await this.ensureState(`${id}.info.refresh`, { name: { en: 'Reload static info (id/net/chdes)', de: 'Statische Infos neu laden (id/net/chdes)', ru: 'Перезагрузить статическую информацию (id/net/chdes)', pt: 'Recarregar informação estática (id/net/chdes)', nl: 'Statische info opnieuw laden (id/net/chdes)', fr: 'Recharger les infos statiques (id/net/chdes)', it: 'Ricarica informazioni statiche (id/net/chdes)', es: 'Recargar información estática (id/net/chdes)', pl: 'Odśwież informacje statyczne (id/net/chdes)', uk: 'Перезавантажити статичну інформацію (id/net/chdes)', 'zh-cn': '重新加载静态信息 (id/net/chdes)' }, type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- network (read-only Anzeige, siehe README für Gründe) ---
        await this.setObjectNotExistsAsync(`${id}.network`, { type: 'channel', common: { name: { en: 'Network', de: 'Netzwerk', ru: 'Сеть', pt: 'Rede', nl: 'Netwerk', fr: 'Réseau', it: 'Rete', es: 'Red', pl: 'Sieć', uk: 'Мережа', 'zh-cn': '网络' } }, native: {} });
        const netFields = {
            ssid: { en: 'SSID', de: 'SSID', ru: 'SSID', pt: 'SSID', nl: 'SSID', fr: 'SSID', it: 'SSID', es: 'SSID', pl: 'SSID', uk: 'SSID', 'zh-cn': 'SSID' },
            ip: { en: 'IP address', de: 'IP-Adresse', ru: 'IP-адрес', pt: 'Endereço IP', nl: 'IP-adres', fr: 'Adresse IP', it: 'Indirizzo IP', es: 'Dirección IP', pl: 'Adres IP', uk: 'IP-адреса', 'zh-cn': 'IP 地址' },
            mac: { en: 'MAC address', de: 'MAC-Adresse', ru: 'MAC-адрес', pt: 'Endereço MAC', nl: 'MAC-adres', fr: 'Adresse MAC', it: 'Indirizzo MAC', es: 'Dirección MAC', pl: 'Adres MAC', uk: 'MAC-адреса', 'zh-cn': 'MAC 地址' },
            mode: { en: 'Network mode (0=AccessPoint, 1=Associate)', de: 'Netzwerkmodus (0=AccessPoint, 1=Associate)', ru: 'Режим сети (0=точка доступа, 1=подключение)', pt: 'Modo de rede (0=Ponto de Acesso, 1=Associar)', nl: 'Netwerkmodus (0=AccessPoint, 1=Associate)', fr: 'Mode réseau (0=point d\'accès, 1=associé)', it: 'Modalità di rete (0=Access Point, 1=Associato)', es: 'Modo de red (0=Punto de acceso, 1=Asociado)', pl: 'Tryb sieci (0=punkt dostępu, 1=powiązanie)', uk: 'Режим мережі (0=точка доступу, 1=підключення)', 'zh-cn': '网络模式 (0=接入点, 1=关联)' },
            enc: { en: 'Encryption', de: 'Verschlüsselung', ru: 'Шифрование', pt: 'Encriptação', nl: 'Versleuteling', fr: 'Chiffrement', it: 'Crittografia', es: 'Cifrado', pl: 'Szyfrowanie', uk: 'Шифрування', 'zh-cn': '加密' },
            mask: { en: 'Subnet mask', de: 'Subnetzmaske', ru: 'Маска подсети', pt: 'Máscara de sub-rede', nl: 'Subnetmasker', fr: 'Masque de sous-réseau', it: 'Maschera di sottorete', es: 'Máscara de subred', pl: 'Maska podsieci', uk: 'Маска підмережі', 'zh-cn': '子网掩码' },
            gw: { en: 'Gateway', de: 'Gateway', ru: 'Шлюз', pt: 'Gateway', nl: 'Gateway', fr: 'Passerelle', it: 'Gateway', es: 'Puerta de enlace', pl: 'Brama', uk: 'Шлюз', 'zh-cn': '网关' },
            bssid: { en: 'MAC address access point', de: 'MAC-Adresse Access Point', ru: 'MAC-адрес точки доступа', pt: 'Endereço MAC do ponto de acesso', nl: 'MAC-adres access point', fr: 'Adresse MAC du point d\'accès', it: 'Indirizzo MAC access point', es: 'Dirección MAC del punto de acceso', pl: 'Adres MAC punktu dostępu', uk: 'MAC-адреса точки доступу', 'zh-cn': '接入点 MAC 地址' }
        };
        for (const [key, name] of Object.entries(netFields)) {
            await this.ensureState(`${id}.network.${key}`, { name, type: 'string', role: 'text', read: true, write: false });
        }

        // --- system ---
        await this.setObjectNotExistsAsync(`${id}.system`, { type: 'channel', common: { name: { en: 'System commands', de: 'Systembefehle', ru: 'Системные команды', pt: 'Comandos do sistema', nl: 'Systeemcommando\'s', fr: 'Commandes système', it: 'Comandi di sistema', es: 'Comandos del sistema', pl: 'Polecenia systemowe', uk: 'Системні команди', 'zh-cn': '系统命令' } }, native: {} });
        await this.ensureState(`${id}.system.reboot`, { name: { en: 'Restart', de: 'Neustart', ru: 'Перезапуск', pt: 'Reiniciar', nl: 'Herstarten', fr: 'Redémarrer', it: 'Riavvio', es: 'Reiniciar', pl: 'Restart', uk: 'Перезапуск', 'zh-cn': '重启' }, type: 'boolean', role: 'button', read: false, write: true, def: false });
        await this.ensureState(`${id}.system.unlock`, {
            name: { en: 'Unlock for factory reset (safety interlock: must be set to true max. 30s BEFORE factoryDefault)', de: 'Entriegelung für Werksreset (Sicherheitsverriegelung: muss max. 30s VOR factoryDefault auf true gesetzt werden)', ru: 'Разблокировка для сброса до заводских настроек (интерлок: должно быть true не более чем за 30с ДО factoryDefault)', pt: 'Desbloqueio para reposição de fábrica (interbloqueio de segurança: deve ser definido como true no máx. 30s ANTES de factoryDefault)', nl: 'Ontgrendeling voor fabrieksreset (veiligheidsvergrendeling: moet max. 30s VOOR factoryDefault op true gezet worden)', fr: 'Déverrouillage pour réinitialisation d\'usine (verrouillage de sécurité : doit être mis à true max. 30s AVANT factoryDefault)', it: 'Sblocco per il ripristino di fabbrica (interblocco di sicurezza: deve essere impostato su true max. 30s PRIMA di factoryDefault)', es: 'Desbloqueo para restablecimiento de fábrica (enclavamiento de seguridad: debe ponerse a true máx. 30s ANTES de factoryDefault)', pl: 'Odblokowanie przywracania ustawień fabrycznych (blokada bezpieczeństwa: musi być ustawione na true maks. 30s PRZED factoryDefault)', uk: 'Розблокування для скидання до заводських налаштувань (блокування безпеки: має бути true не більше ніж за 30с ДО factoryDefault)', 'zh-cn': '解锁恢复出厂设置（安全联锁：必须在 factoryDefault 之前最多 30 秒设置为 true）' },
            type: 'boolean', role: 'button', read: false, write: true, def: false
        });
        await this.ensureState(`${id}.system.factoryDefault`, { name: { en: 'WARNING: Factory reset - deletes ALL settings incl. WLAN, device will drop off the network! Requires prior system.unlock (30s window)', de: 'ACHTUNG: Werksreset - löscht ALLE Einstellungen inkl. WLAN, Gerät fällt vom Netz! Erfordert vorheriges system.unlock (30s-Fenster)', ru: 'ВНИМАНИЕ: сброс до заводских настроек - удаляет ВСЕ настройки, вкл. WLAN, устройство отключится от сети! Требуется предварительный system.unlock (окно 30с)', pt: 'ATENÇÃO: reposição de fábrica - apaga TODAS as definições incl. WLAN, o dispositivo sairá da rede! Requer system.unlock prévio (janela de 30s)', nl: 'LET OP: fabrieksreset - wist ALLE instellingen incl. WLAN, apparaat valt van het netwerk! Vereist voorafgaand system.unlock (30s-venster)', fr: 'ATTENTION : réinitialisation d\'usine - supprime TOUS les réglages, y compris le WLAN, l\'appareil sera déconnecté du réseau ! Nécessite un system.unlock préalable (fenêtre de 30s)', it: 'ATTENZIONE: ripristino di fabbrica - cancella TUTTE le impostazioni incl. WLAN, il dispositivo si disconnette dalla rete! Richiede system.unlock preventivo (finestra di 30s)', es: 'ATENCIÓN: restablecimiento de fábrica - borra TODOS los ajustes incl. WLAN, ¡el dispositivo se desconectará de la red! Requiere system.unlock previo (ventana de 30s)', pl: 'UWAGA: przywrócenie ustawień fabrycznych - usuwa WSZYSTKIE ustawienia wraz z WLAN, urządzenie odłączy się od sieci! Wymaga wcześniejszego system.unlock (okno 30s)', uk: 'УВАГА: скидання до заводських налаштувань - видаляє ВСІ налаштування, включно з WLAN, пристрій відключиться від мережі! Потрібен попередній system.unlock (вікно 30с)', 'zh-cn': '警告：恢复出厂设置 - 将删除所有设置（包括 WLAN），设备将离线！需要事先执行 system.unlock（30秒窗口）' }, type: 'boolean', role: 'button', read: false, write: true, def: false });
        await this.ensureState(`${id}.system.networkDefault`, { name: { en: 'Back to access point mode (configuration is retained)', de: 'Zurück in Access-Point-Modus (Konfiguration bleibt erhalten)', ru: 'Вернуться в режим точки доступа (конфигурация сохраняется)', pt: 'Voltar ao modo ponto de acesso (a configuração é mantida)', nl: 'Terug naar access point-modus (configuratie blijft behouden)', fr: 'Retour en mode point d\'accès (la configuration est conservée)', it: 'Torna alla modalità access point (la configurazione viene mantenuta)', es: 'Volver al modo punto de acceso (se conserva la configuración)', pl: 'Powrót do trybu punktu dostępu (konfiguracja zostaje zachowana)', uk: 'Повернутися в режим точки доступу (конфігурація зберігається)', 'zh-cn': '返回接入点模式（保留配置）' }, type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- location (zrap/loc) ---
        await this.setObjectNotExistsAsync(`${id}.location`, { type: 'channel', common: { name: { en: 'Location', de: 'Standort', ru: 'Местоположение', pt: 'Localização', nl: 'Locatie', fr: 'Emplacement', it: 'Posizione', es: 'Ubicación', pl: 'Lokalizacja', uk: 'Розташування', 'zh-cn': '位置' } }, native: {} });
        await this.ensureState(`${id}.location.name`, { name: { en: 'Location label (freely choosable, e.g. "Fideris Valzigg")', de: 'Standortbezeichnung (frei wählbar, z.B. "Fideris Valzigg")', ru: 'Обозначение местоположения (произвольное, напр. "Fideris Valzigg")', pt: 'Designação da localização (livremente escolhível, p.ex. "Fideris Valzigg")', nl: 'Locatieomschrijving (vrij te kiezen, bijv. "Fideris Valzigg")', fr: 'Nom de l\'emplacement (libre, p.ex. "Fideris Valzigg")', it: 'Descrizione della posizione (a scelta libera, es. "Fideris Valzigg")', es: 'Nombre de la ubicación (libre, p.ej. "Fideris Valzigg")', pl: 'Nazwa lokalizacji (dowolna, np. "Fideris Valzigg")', uk: 'Позначення розташування (довільне, напр. "Fideris Valzigg")', 'zh-cn': '位置名称（可自定义，例如 "Fideris Valzigg"）' }, type: 'string', role: 'text', read: true, write: true });

        // --- ntp (zrap/ntp) ---
        await this.setObjectNotExistsAsync(`${id}.ntp`, { type: 'channel', common: { name: { en: 'NTP', de: 'NTP', ru: 'NTP', pt: 'NTP', nl: 'NTP', fr: 'NTP', it: 'NTP', es: 'NTP', pl: 'NTP', uk: 'NTP', 'zh-cn': 'NTP' } }, native: {} });
        await this.ensureState(`${id}.ntp.url`, { name: { en: 'NTP server (URL/IP, max. 32 characters)', de: 'NTP-Server (URL/IP, max. 32 Zeichen)', ru: 'NTP-сервер (URL/IP, макс. 32 символа)', pt: 'Servidor NTP (URL/IP, máx. 32 caracteres)', nl: 'NTP-server (URL/IP, max. 32 tekens)', fr: 'Serveur NTP (URL/IP, max. 32 caractères)', it: 'Server NTP (URL/IP, max. 32 caratteri)', es: 'Servidor NTP (URL/IP, máx. 32 caracteres)', pl: 'Serwer NTP (URL/IP, maks. 32 znaki)', uk: 'NTP-сервер (URL/IP, макс. 32 символи)', 'zh-cn': 'NTP 服务器（URL/IP，最多 32 个字符）' }, type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.ntp.per`, { name: { en: 'Polling interval in hours (0=disabled)', de: 'Abfrageintervall in Stunden (0=deaktiviert)', ru: 'Интервал опроса в часах (0=отключено)', pt: 'Intervalo de consulta em horas (0=desativado)', nl: 'Poll-interval in uren (0=uitgeschakeld)', fr: 'Intervalle d\'interrogation en heures (0=désactivé)', it: 'Intervallo di polling in ore (0=disattivato)', es: 'Intervalo de consulta en horas (0=desactivado)', pl: 'Interwał odpytywania w godzinach (0=wyłączone)', uk: 'Інтервал опитування в годинах (0=вимкнено)', 'zh-cn': '轮询间隔（小时，0=禁用）' }, type: 'number', role: 'level', read: true, write: true, min: 0, max: 255 });

        // --- date (zrap/date) ---
        await this.setObjectNotExistsAsync(`${id}.date`, { type: 'channel', common: { name: { en: 'Date/time', de: 'Datum/Zeit', ru: 'Дата/время', pt: 'Data/hora', nl: 'Datum/tijd', fr: 'Date/heure', it: 'Data/ora', es: 'Fecha/hora', pl: 'Data/godzina', uk: 'Дата/час', 'zh-cn': '日期/时间' } }, native: {} });
        await this.ensureState(`${id}.date.rfc1123`, { name: { en: 'RFC1123 timestamp (must be GMT)', de: 'RFC1123 Zeitstempel (muss GMT sein)', ru: 'Метка времени RFC1123 (должна быть GMT)', pt: 'Timestamp RFC1123 (deve ser GMT)', nl: 'RFC1123-tijdstempel (moet GMT zijn)', fr: 'Horodatage RFC1123 (doit être GMT)', it: 'Timestamp RFC1123 (deve essere GMT)', es: 'Marca de tiempo RFC1123 (debe ser GMT)', pl: 'Znacznik czasu RFC1123 (musi być GMT)', uk: 'Мітка часу RFC1123 (має бути GMT)', 'zh-cn': 'RFC1123 时间戳（必须为 GMT）' }, type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.tz`, { name: { en: 'Timezone offset HHMM (e.g. +0200)', de: 'Zeitzonen-Offset HHMM (z.B. +0200)', ru: 'Смещение часового пояса HHMM (напр. +0200)', pt: 'Offset de fuso horário HHMM (p.ex. +0200)', nl: 'Tijdzone-offset HHMM (bijv. +0200)', fr: 'Décalage de fuseau horaire HHMM (p.ex. +0200)', it: 'Offset fuso orario HHMM (es. +0200)', es: 'Desfase horario HHMM (p.ej. +0200)', pl: 'Przesunięcie strefy czasowej HHMM (np. +0200)', uk: 'Зміщення часового поясу HHMM (напр. +0200)', 'zh-cn': '时区偏移 HHMM（例如 +0200）' }, type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.dst`, { name: { en: 'Daylight saving offset HHMM', de: 'Sommerzeit-Offset HHMM', ru: 'Смещение летнего времени HHMM', pt: 'Offset de horário de verão HHMM', nl: 'Zomertijd-offset HHMM', fr: 'Décalage heure d\'été HHMM', it: 'Offset ora legale HHMM', es: 'Desfase de horario de verano HHMM', pl: 'Przesunięcie czasu letniego HHMM', uk: 'Зміщення літнього часу HHMM', 'zh-cn': '夏令时偏移 HHMM' }, type: 'string', role: 'text', read: true, write: true });
        await this.ensureState(`${id}.date.syncNow`, { name: { en: 'Button: synchronize device time with the ioBroker host', de: 'Button: Geräte-Uhrzeit mit ioBroker-Host synchronisieren', ru: 'Кнопка: синхронизировать время устройства с хостом ioBroker', pt: 'Botão: sincronizar hora do dispositivo com o host ioBroker', nl: 'Knop: apparaatklok synchroniseren met de ioBroker-host', fr: 'Bouton : synchroniser l\'heure de l\'appareil avec l\'hôte ioBroker', it: 'Pulsante: sincronizza l\'ora del dispositivo con l\'host ioBroker', es: 'Botón: sincronizar la hora del dispositivo con el host de ioBroker', pl: 'Przycisk: synchronizuj czas urządzenia z hostem ioBroker', uk: 'Кнопка: синхронізувати час пристрою з хостом ioBroker', 'zh-cn': '按钮：将设备时间与 ioBroker 主机同步' }, type: 'boolean', role: 'button', read: false, write: true, def: false });

        // --- smartfront (zapi, optional - nur bei angeschlossenem Smartfront-Taster) ---
        if (dev.cfg.smartfront) {
            await this.setObjectNotExistsAsync(`${id}.smartfront`, { type: 'channel', common: { name: { en: 'Smartfront', de: 'Smartfront', ru: 'Smartfront', pt: 'Smartfront', nl: 'Smartfront', fr: 'Smartfront', it: 'Smartfront', es: 'Smartfront', pl: 'Smartfront', uk: 'Smartfront', 'zh-cn': 'Smartfront' } }, native: {} });
            await this.ensureState(`${id}.smartfront.temp`, { name: { en: 'Temperature', de: 'Temperatur', ru: 'Температура', pt: 'Temperatura', nl: 'Temperatuur', fr: 'Température', it: 'Temperatura', es: 'Temperatura', pl: 'Temperatura', uk: 'Температура', 'zh-cn': '温度' }, type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false });
            await this.ensureState(`${id}.smartfront.lux`, { name: { en: 'Brightness', de: 'Helligkeit', ru: 'Яркость', pt: 'Luminosidade', nl: 'Helderheid', fr: 'Luminosité', it: 'Luminosità', es: 'Luminosidad', pl: 'Jasność', uk: 'Яскравість', 'zh-cn': '亮度' }, type: 'number', role: 'value.brightness', unit: 'lx', read: true, write: false });
            await this.ensureState(`${id}.smartfront.hum`, { name: { en: 'Humidity', de: 'Luftfeuchtigkeit', ru: 'Влажность', pt: 'Humidade', nl: 'Luchtvochtigheid', fr: 'Humidité', it: 'Umidità', es: 'Humedad', pl: 'Wilgotność', uk: 'Вологість', 'zh-cn': '湿度' }, type: 'number', role: 'value.humidity', unit: '%', read: true, write: false });
            await this.ensureState(`${id}.smartfront.ledState`, { name: { en: 'Current LED status (JSON, read-only)', de: 'Aktueller LED-Status (JSON, read-only)', ru: 'Текущий статус светодиода (JSON, только чтение)', pt: 'Estado atual do LED (JSON, só leitura)', nl: 'Huidige LED-status (JSON, alleen-lezen)', fr: 'État actuel de la LED (JSON, lecture seule)', it: 'Stato attuale del LED (JSON, sola lettura)', es: 'Estado actual del LED (JSON, solo lectura)', pl: 'Aktualny stan LED (JSON, tylko do odczytu)', uk: 'Поточний стан світлодіода (JSON, лише читання)', 'zh-cn': '当前 LED 状态（JSON，只读）' }, type: 'string', role: 'json', read: true, write: false });
            await this.ensureState(`${id}.smartfront.ledSet`, {
                name: { en: 'Set LED(s) - JSON array as in API doc 5.1.3.4, e.g. [{"id":2,"bg":"#220000"}]. Per the docs, only "bg" (background color) is safe to set externally.', de: 'LED(s) setzen - JSON-Array wie in API-Doku 5.1.3.4, z.B. [{"id":2,"bg":"#220000"}]. Laut Doku nur "bg" (Hintergrundfarbe) unbedenklich extern setzbar.', ru: 'Установить LED - JSON-массив как в документации API 5.1.3.4, напр. [{"id":2,"bg":"#220000"}]. Согласно документации, только "bg" (цвет фона) безопасно устанавливать извне.', pt: 'Definir LED(s) - array JSON conforme doc. API 5.1.3.4, p.ex. [{"id":2,"bg":"#220000"}]. Segundo a documentação, apenas "bg" (cor de fundo) pode ser definido externamente com segurança.', nl: 'LED(s) instellen - JSON-array zoals in API-doc 5.1.3.4, bijv. [{"id":2,"bg":"#220000"}]. Volgens de documentatie is alleen "bg" (achtergrondkleur) veilig extern instelbaar.', fr: 'Définir la/les LED - tableau JSON comme dans la doc API 5.1.3.4, p.ex. [{"id":2,"bg":"#220000"}]. Selon la doc, seul "bg" (couleur de fond) peut être défini en externe sans risque.', it: 'Imposta LED - array JSON come da documentazione API 5.1.3.4, es. [{"id":2,"bg":"#220000"}]. Secondo la documentazione, solo "bg" (colore di sfondo) è sicuro da impostare esternamente.', es: 'Definir LED(s) - array JSON como en la doc. API 5.1.3.4, p.ej. [{"id":2,"bg":"#220000"}]. Según la documentación, solo "bg" (color de fondo) es seguro de establecer externamente.', pl: 'Ustaw LED - tablica JSON jak w dokumentacji API 5.1.3.4, np. [{"id":2,"bg":"#220000"}]. Wg dokumentacji tylko "bg" (kolor tła) można bezpiecznie ustawiać zewnętrznie.', uk: 'Встановити світлодіоди - JSON-масив як у документації API 5.1.3.4, напр. [{"id":2,"bg":"#220000"}]. Згідно з документацією, лише "bg" (колір фону) безпечно встановлювати ззовні.', 'zh-cn': '设置 LED - JSON 数组，格式见 API 文档 5.1.3.4，例如 [{"id":2,"bg":"#220000"}]。根据文档，仅 "bg"（背景色）可安全地从外部设置。' },
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

        await this.setObjectNotExistsAsync(`${id}.channels`, { type: 'channel', common: { name: { en: 'Channels', de: 'Kanäle', ru: 'Каналы', pt: 'Canais', nl: 'Kanalen', fr: 'Canaux', it: 'Canali', es: 'Canales', pl: 'Kanały', uk: 'Канали', 'zh-cn': '通道' } }, native: {} });
        for (let n = 1; n <= channelCount; n++) {
            const ch = `${id}.channels.ch${n}`;
            await this.setObjectNotExistsAsync(ch, {
                type: 'channel',
                common: { name: {
                    en: `Channel ${n}`, de: `Kanal ${n}`, ru: `Канал ${n}`, pt: `Canal ${n}`, nl: `Kanaal ${n}`,
                    fr: `Canal ${n}`, it: `Canale ${n}`, es: `Canal ${n}`, pl: `Kanał ${n}`, uk: `Канал ${n}`, 'zh-cn': `通道 ${n}`
                } },
                native: { channelNumber: n, host: dev.cfg.host, kind }
            });

            await this.ensureState(`${ch}.val`, {
                name: { en: 'State (0-100, for shutters usually -1=unknown)', de: 'Zustand (0-100, bei Storen meist -1=unbekannt)', ru: 'Состояние (0-100, для жалюзи обычно -1=неизвестно)', pt: 'Estado (0-100, em estores geralmente -1=desconhecido)', nl: 'Status (0-100, bij zonwering meestal -1=onbekend)', fr: 'État (0-100, pour les stores généralement -1=inconnu)', it: 'Stato (0-100, per le tapparelle solitamente -1=sconosciuto)', es: 'Estado (0-100, en persianas normalmente -1=desconocido)', pl: 'Stan (0-100, dla rolet zwykle -1=nieznany)', uk: 'Стан (0-100, для жалюзі зазвичай -1=невідомо)', 'zh-cn': '状态 (0-100，卷帘通常 -1=未知)' },
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
                            ? { en: 'Estimated actual position 0=closed/100=open (software estimate display only, NO hardware feedback; use "calibrate" to calibrate, "setPosition" to move)', de: 'Geschätzte Ist-Position 0=zu/100=offen (reine Anzeige der Software-Schätzung, KEINE Hardware-Rückmeldung; zum Kalibrieren "calibrate" verwenden, zum Anfahren "setPosition")', ru: 'Расчётная текущая позиция 0=закрыто/100=открыто (только программная оценка, БЕЗ обратной связи от оборудования; для калибровки используйте "calibrate", для перемещения "setPosition")', pt: 'Posição atual estimada 0=fechado/100=aberto (apenas exibição de estimativa por software, SEM feedback de hardware; use "calibrate" para calibrar, "setPosition" para mover)', nl: 'Geschatte werkelijke positie 0=dicht/100=open (alleen software-schatting, GEEN hardware-terugkoppeling; gebruik "calibrate" om te kalibreren, "setPosition" om te bewegen)', fr: 'Position réelle estimée 0=fermé/100=ouvert (affichage logiciel uniquement, PAS de retour matériel ; utiliser "calibrate" pour calibrer, "setPosition" pour déplacer)', it: 'Posizione effettiva stimata 0=chiuso/100=aperto (solo visualizzazione stima software, NESSUN feedback hardware; usare "calibrate" per calibrare, "setPosition" per muovere)', es: 'Posición real estimada 0=cerrado/100=abierto (solo visualización de estimación por software, SIN retroalimentación de hardware; usar "calibrate" para calibrar, "setPosition" para mover)', pl: 'Szacowana pozycja rzeczywista 0=zamknięte/100=otwarte (tylko wyświetlanie szacunku programowego, BRAK sprzężenia zwrotnego sprzętu; użyj "calibrate" do kalibracji, "setPosition" do przesunięcia)', uk: 'Розрахункова фактична позиція 0=закрито/100=відкрито (лише програмна оцінка, БЕЗ апаратного зворотного зв\'язку; для калібрування використовуйте "calibrate", для переміщення "setPosition")', 'zh-cn': '估计的实际位置 0=关闭/100=打开（仅软件估算显示，无硬件反馈；使用 "calibrate" 校准，"setPosition" 移动）' }
                            : { en: 'Estimated position (disabled - set "Shutter motor runtime" to >0s)', de: 'Geschätzte Position (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)', ru: 'Расчётная позиция (отключено - установите "Время работы мотора жалюзи" > 0с)', pt: 'Posição estimada (desativado - definir "Tempo de funcionamento do motor" para >0s)', nl: 'Geschatte positie (uitgeschakeld - "Looptijd zonweringmotor" op >0s zetten)', fr: 'Position estimée (désactivé - régler "Durée du moteur de store" sur >0s)', it: 'Posizione stimata (disattivato - impostare "Tempo di funzionamento motore tapparella" su >0s)', es: 'Posición estimada (desactivado - establecer "Tiempo de funcionamiento del motor de persiana" a >0s)', pl: 'Szacowana pozycja (wyłączone - ustaw "Czas pracy silnika rolety" na >0s)', uk: 'Розрахункова позиція (вимкнено - встановіть "Час роботи двигуна жалюзі" > 0с)', 'zh-cn': '估计位置（已禁用 - 将"卷帘电机运行时间"设置为大于0秒）' },
                        type: 'number', role: 'value.blind', min: 0, max: 100, read: true, write: false
                    },
                    native: {}
                });
                await this.extendObjectAsync(`${ch}.setPosition`, {
                    type: 'state',
                    common: {
                        name: hasTravel
                            ? { en: 'Move to position 0=closed/100=open (time-based via move pulses; 0/100 run as a real end-limit run and recalibrate the estimate)', de: 'Position anfahren 0=zu/100=offen (zeitbasiert über move-Impulse; 0/100 fahren als echte Endlagenfahrt und rekalibrieren die Schätzung)', ru: 'Переместить в позицию 0=закрыто/100=открыто (по времени через импульсы move; 0/100 выполняются как реальный ход до концевого положения и перекалибровка оценки)', pt: 'Mover para a posição 0=fechado/100=aberto (baseado em tempo via impulsos move; 0/100 executam como percurso real até ao fim de curso e recalibram a estimativa)', nl: 'Naar positie bewegen 0=dicht/100=open (tijdgebaseerd via move-pulsen; 0/100 rijden als echte eindpositierit en herkalibreren de schatting)', fr: 'Déplacer vers la position 0=fermé/100=ouvert (basé sur le temps via des impulsions move ; 0/100 effectuent une vraie course en fin de course et recalibrent l\'estimation)', it: 'Sposta in posizione 0=chiuso/100=aperto (basato sul tempo tramite impulsi move; 0/100 eseguono una vera corsa di fine corsa e ricalibrano la stima)', es: 'Mover a la posición 0=cerrado/100=abierto (basado en tiempo mediante impulsos move; 0/100 se ejecutan como una carrera real hasta el final de recorrido y recalibran la estimación)', pl: 'Przesuń do pozycji 0=zamknięte/100=otwarte (oparte na czasie za pomocą impulsów move; 0/100 wykonują rzeczywisty przebieg do położenia krańcowego i rekalibrują szacunek)', uk: 'Перемістити в позицію 0=закрито/100=відкрито (за часом через імпульси move; 0/100 виконуються як реальний хід до кінцевого положення та перекалібровують оцінку)', 'zh-cn': '移动到位置 0=关闭/100=打开（通过 move 脉冲按时间计算；0/100 作为真实限位行程运行并重新校准估算值）' }
                            : { en: 'Move to position (disabled - set "Shutter motor runtime" to >0s)', de: 'Position anfahren (deaktiviert - "Laufzeit Storenmotor" auf >0s setzen)', ru: 'Переместить в позицию (отключено - установите "Время работы мотора жалюзи" > 0с)', pt: 'Mover para a posição (desativado - definir "Tempo de funcionamento do motor" para >0s)', nl: 'Naar positie bewegen (uitgeschakeld - "Looptijd zonweringmotor" op >0s zetten)', fr: 'Déplacer vers la position (désactivé - régler "Durée du moteur de store" sur >0s)', it: 'Sposta in posizione (disattivato - impostare "Tempo di funzionamento motore tapparella" su >0s)', es: 'Mover a la posición (desactivado - establecer "Tiempo de funcionamiento del motor de persiana" a >0s)', pl: 'Przesuń do pozycji (wyłączone - ustaw "Czas pracy silnika rolety" na >0s)', uk: 'Перемістити в позицію (вимкнено - встановіть "Час роботи двигуна жалюзі" > 0с)', 'zh-cn': '移动到位置（已禁用 - 将"卷帘电机运行时间"设置为大于0秒）' },
                        type: 'number', role: 'level.blind', min: 0, max: 100, read: true, write: true
                    },
                    native: {}
                });
                await this.ensureState(`${ch}.calibrate`, {
                    name: { en: 'Set the estimate WITHOUT moving (e.g. after manual operation at the wall switch): enter the current actual state in %', de: 'Schätzung setzen OHNE Fahrt (z.B. nach manueller Bedienung am Wandtaster): aktuellen Ist-Zustand in % eintragen', ru: 'Установить оценку БЕЗ движения (напр. после ручного управления настенным выключателем): ввести текущее фактическое состояние в %', pt: 'Definir a estimativa SEM movimento (p.ex. após operação manual no interruptor de parede): introduzir o estado atual em %', nl: 'Schatting instellen ZONDER beweging (bijv. na handmatige bediening op de wandschakelaar): huidige werkelijke status in % invoeren', fr: 'Définir l\'estimation SANS mouvement (p.ex. après commande manuelle sur l\'interrupteur mural) : saisir l\'état réel actuel en %', it: 'Imposta la stima SENZA movimento (es. dopo comando manuale sul pulsante a muro): inserire lo stato attuale in %', es: 'Definir la estimación SIN movimiento (p.ej. tras el manejo manual en el interruptor de pared): introducir el estado actual en %', pl: 'Ustaw szacunek BEZ ruchu (np. po ręcznej obsłudze przełącznika ściennego): wpisz aktualny stan rzeczywisty w %', uk: 'Встановити оцінку БЕЗ руху (напр. після ручного керування настінним вимикачем): ввести поточний фактичний стан у %', 'zh-cn': '设置估计值但不移动（例如手动操作墙壁开关后）：输入当前实际状态百分比' },
                    type: 'number', role: 'level', min: 0, max: 100, read: true, write: true
                });
                await this.extendObjectAsync(`${ch}.tiltOpen`, {
                    type: 'state',
                    common: {
                        name: dev.cfg.tiltTimeMs
                            ? { en: `Tilt slats open (pulse ${dev.cfg.tiltTimeMs}ms)`, de: `Lamellen kippen Richtung offen (Impuls ${dev.cfg.tiltTimeMs}ms)`, ru: `Наклонить ламели открыто (импульс ${dev.cfg.tiltTimeMs}мс)`, pt: `Inclinar réguas para abrir (impulso ${dev.cfg.tiltTimeMs}ms)`, nl: `Lamellen kantelen richting open (puls ${dev.cfg.tiltTimeMs}ms)`, fr: `Incliner les lamelles vers l'ouverture (impulsion ${dev.cfg.tiltTimeMs}ms)`, it: `Inclina lamelle verso apertura (impulso ${dev.cfg.tiltTimeMs}ms)`, es: `Inclinar lamas hacia abierto (impulso ${dev.cfg.tiltTimeMs}ms)`, pl: `Przechyl lamele w kierunku otwarcia (impuls ${dev.cfg.tiltTimeMs}ms)`, uk: `Нахилити ламелі відкрито (імпульс ${dev.cfg.tiltTimeMs}мс)`, 'zh-cn': `叶片向开启方向倾斜（脉冲 ${dev.cfg.tiltTimeMs}毫秒）` }
                            : { en: 'Tilt slats (disabled - set "Tilt pulse (ms)" in the configuration)', de: 'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)', ru: 'Наклонить ламели (отключено - установите "Импульс наклона (мс)" в конфигурации)', pt: 'Inclinar réguas (desativado - definir "Impulso de inclinação (ms)" na configuração)', nl: 'Lamellen kantelen (uitgeschakeld - "Kantelpuls (ms)" in de configuratie instellen)', fr: 'Incliner les lamelles (désactivé - régler "Impulsion d\'inclinaison (ms)" dans la configuration)', it: 'Inclina lamelle (disattivato - impostare "Impulso di inclinazione (ms)" nella configurazione)', es: 'Inclinar lamas (desactivado - establecer "Impulso de inclinación (ms)" en la configuración)', pl: 'Przechyl lamele (wyłączone - ustaw "Impuls przechyłu (ms)" w konfiguracji)', uk: 'Нахилити ламелі (вимкнено - встановіть "Імпульс нахилу (мс)" у конфігурації)', 'zh-cn': '倾斜叶片（已禁用 - 请在配置中设置"倾斜脉冲（毫秒）"）' },
                        type: 'boolean', role: 'button', read: false, write: true, def: false
                    },
                    native: {}
                });
                await this.extendObjectAsync(`${ch}.tiltClose`, {
                    type: 'state',
                    common: {
                        name: dev.cfg.tiltTimeMs
                            ? { en: `Tilt slats closed (pulse ${dev.cfg.tiltTimeMs}ms)`, de: `Lamellen kippen Richtung zu (Impuls ${dev.cfg.tiltTimeMs}ms)`, ru: `Наклонить ламели закрыто (импульс ${dev.cfg.tiltTimeMs}мс)`, pt: `Inclinar réguas para fechar (impulso ${dev.cfg.tiltTimeMs}ms)`, nl: `Lamellen kantelen richting dicht (puls ${dev.cfg.tiltTimeMs}ms)`, fr: `Incliner les lamelles vers la fermeture (impulsion ${dev.cfg.tiltTimeMs}ms)`, it: `Inclina lamelle verso chiusura (impulso ${dev.cfg.tiltTimeMs}ms)`, es: `Inclinar lamas hacia cerrado (impulso ${dev.cfg.tiltTimeMs}ms)`, pl: `Przechyl lamele w kierunku zamknięcia (impuls ${dev.cfg.tiltTimeMs}ms)`, uk: `Нахилити ламелі закрито (імпульс ${dev.cfg.tiltTimeMs}мс)`, 'zh-cn': `叶片向关闭方向倾斜（脉冲 ${dev.cfg.tiltTimeMs}毫秒）` }
                            : { en: 'Tilt slats (disabled - set "Tilt pulse (ms)" in the configuration)', de: 'Lamellen kippen (deaktiviert - "Kipp-Impuls (ms)" in der Konfiguration setzen)', ru: 'Наклонить ламели (отключено - установите "Импульс наклона (мс)" в конфигурации)', pt: 'Inclinar réguas (desativado - definir "Impulso de inclinação (ms)" na configuração)', nl: 'Lamellen kantelen (uitgeschakeld - "Kantelpuls (ms)" in de configuratie instellen)', fr: 'Incliner les lamelles (désactivé - régler "Impulsion d\'inclinaison (ms)" dans la configuration)', it: 'Inclina lamelle (disattivato - impostare "Impulso di inclinazione (ms)" nella configurazione)', es: 'Inclinar lamas (desactivado - establecer "Impulso de inclinación (ms)" en la configuración)', pl: 'Przechyl lamele (wyłączone - ustaw "Impuls przechyłu (ms)" w konfiguracji)', uk: 'Нахилити ламелі (вимкнено - встановіть "Імпульс нахилу (мс)" у конфігурації)', 'zh-cn': '倾斜叶片（已禁用 - 请在配置中设置"倾斜脉冲（毫秒）"）' },
                        type: 'boolean', role: 'button', read: false, write: true, def: false
                    },
                    native: {}
                });
            }

            await this.ensureState(`${ch}.name`, { name: { en: 'Channel name (chdes)', de: 'Kanalname (chdes)', ru: 'Имя канала (chdes)', pt: 'Nome do canal (chdes)', nl: 'Kanaalnaam (chdes)', fr: 'Nom du canal (chdes)', it: 'Nome canale (chdes)', es: 'Nombre del canal (chdes)', pl: 'Nazwa kanału (chdes)', uk: 'Ім\'я каналу (chdes)', 'zh-cn': '通道名称 (chdes)' }, type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.group`, { name: { en: 'Group (chdes)', de: 'Gruppe (chdes)', ru: 'Группа (chdes)', pt: 'Grupo (chdes)', nl: 'Groep (chdes)', fr: 'Groupe (chdes)', it: 'Gruppo (chdes)', es: 'Grupo (chdes)', pl: 'Grupa (chdes)', uk: 'Група (chdes)', 'zh-cn': '分组 (chdes)' }, type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.icon`, { name: { en: 'Icon (chdes)', de: 'Icon (chdes)', ru: 'Иконка (chdes)', pt: 'Ícone (chdes)', nl: 'Icoon (chdes)', fr: 'Icône (chdes)', it: 'Icona (chdes)', es: 'Icono (chdes)', pl: 'Ikona (chdes)', uk: 'Іконка (chdes)', 'zh-cn': '图标 (chdes)' }, type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.type`, { name: { en: 'Type code (chdes)', de: 'Typ-Code (chdes)', ru: 'Код типа (chdes)', pt: 'Código de tipo (chdes)', nl: 'Typecode (chdes)', fr: 'Code de type (chdes)', it: 'Codice tipo (chdes)', es: 'Código de tipo (chdes)', pl: 'Kod typu (chdes)', uk: 'Код типу (chdes)', 'zh-cn': '类型代码 (chdes)' }, type: 'string', role: 'text', read: true, write: true });
            await this.ensureState(`${ch}.cat`, { name: { en: 'Category code (chdes)', de: 'Kategorie-Code (chdes)', ru: 'Код категории (chdes)', pt: 'Código de categoria (chdes)', nl: 'Categoriecode (chdes)', fr: 'Code de catégorie (chdes)', it: 'Codice categoria (chdes)', es: 'Código de categoría (chdes)', pl: 'Kod kategorii (chdes)', uk: 'Код категорії (chdes)', 'zh-cn': '类别代码 (chdes)' }, type: 'string', role: 'text', read: true, write: true });

            await this.ensureState(`${ch}.command`, {
                name: { en: 'Free-text command (e.g. dim_2000, move_close_5000, recall_s1 ...)', de: 'Freier Befehl (z.B. dim_2000, move_close_5000, recall_s1 …)', ru: 'Произвольная команда (напр. dim_2000, move_close_5000, recall_s1 …)', pt: 'Comando livre (p.ex. dim_2000, move_close_5000, recall_s1 …)', nl: 'Vrije opdracht (bijv. dim_2000, move_close_5000, recall_s1 …)', fr: 'Commande libre (p.ex. dim_2000, move_close_5000, recall_s1 …)', it: 'Comando libero (es. dim_2000, move_close_5000, recall_s1 …)', es: 'Comando libre (p.ej. dim_2000, move_close_5000, recall_s1 …)', pl: 'Dowolne polecenie (np. dim_2000, move_close_5000, recall_s1 …)', uk: 'Довільна команда (напр. dim_2000, move_close_5000, recall_s1 …)', 'zh-cn': '自由命令（例如 dim_2000, move_close_5000, recall_s1 …）' },
                type: 'string', role: 'text', read: false, write: true, def: ''
            });

            for (const [cmd, name] of Object.entries(CH_BUTTONS)) {
                await this.ensureState(`${ch}.${cmd}`, {
                    name, type: 'boolean', role: btnRoles[cmd] || 'button', read: false, write: true, def: false
                });
            }
            for (let s = 1; s <= 4; s++) {
                const sceneName = (verb) => ({
                    en: `Scene ${s} ${verb.en}`, de: `Szene ${s} ${verb.de}`, ru: `Сцена ${s}: ${verb.ru}`,
                    pt: `Cena ${s} ${verb.pt}`, nl: `Scène ${s} ${verb.nl}`, fr: `Scène ${s} ${verb.fr}`,
                    it: `Scena ${s} ${verb.it}`, es: `Escena ${s} ${verb.es}`, pl: `Scena ${s}: ${verb.pl}`,
                    uk: `Сцена ${s}: ${verb.uk}`, 'zh-cn': `场景 ${s} ${verb['zh-cn']}`
                });
                await this.ensureState(`${ch}.recall_s${s}`, { name: sceneName({ en: 'recall', de: 'abrufen', ru: 'вызвать', pt: 'chamar', nl: 'oproepen', fr: 'rappeler', it: 'richiama', es: 'recuperar', pl: 'przywołaj', uk: 'викликати', 'zh-cn': '调用' }), type: 'boolean', role: 'button', read: false, write: true, def: false });
                await this.ensureState(`${ch}.store_s${s}`, { name: sceneName({ en: 'store', de: 'speichern', ru: 'сохранить', pt: 'guardar', nl: 'opslaan', fr: 'enregistrer', it: 'salva', es: 'guardar', pl: 'zapisz', uk: 'зберегти', 'zh-cn': '保存' }), type: 'boolean', role: 'button', read: false, write: true, def: false });
                await this.ensureState(`${ch}.delete_s${s}`, { name: sceneName({ en: 'delete', de: 'löschen', ru: 'удалить', pt: 'eliminar', nl: 'verwijderen', fr: 'supprimer', it: 'elimina', es: 'eliminar', pl: 'usuń', uk: 'видалити', 'zh-cn': '删除' }), type: 'boolean', role: 'button', read: false, write: true, def: false });
            }
        }
    }

    // ------------------------------------------------------------- HTTP-IO

    async zrapGet(id, path, axiosOpts = {}) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unknown device ${id}`);
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
        if (!dev) throw new Error(`Unknown device ${id}`);
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
        if (!dev) throw new Error(`Unknown device ${id}`);
        const res = await dev.client.get(path);
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res.data;
    }

    async zapiPost(id, path, jsonBody) {
        const dev = this.devices[id];
        if (!dev) throw new Error(`Unknown device ${id}`);
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
            throw new Error(`${fieldName}: ${bytes} bytes exceed the API limit of ${maxBytes} bytes (note: umlauts count as 2 bytes)`);
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
            return Promise.reject(new Error(`Invalid channel command "${cmd}"`));
        }
        const dev = this.devices[id];
        if (!dev) return Promise.reject(new Error(`Unknown device ${id}`));

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
                this.log.info(`[${id}] Channel command sent: ch${chNum} -> ${cmds[chNum]}`);
            } else {
                const body = {};
                for (const chNum of chNums) body[`cmd${chNum}`] = cmds[chNum];
                await this.zrapPost(id, '/zrap/chctrl', body);
                const summary = chNums.map(n => `ch${n}->${cmds[n]}`).join(', ');
                this.log.info(`[${id}] Multicast command sent: ${summary}`);
                this.log.debug(`[${id}] Multicast command bundled: ${JSON.stringify(body)}`);
            }
            for (const chNum of chNums) {
                this.markChannelBusy(dev, chNum, cmds[chNum]);
                this.updatePositionEstimate(id, parseInt(chNum, 10), cmds[chNum]).catch(() => {});
            }
            callbacks.forEach(cb => cb.resolve());
        } catch (err) {
            const summary = chNums.map(n => `ch${n}->${cmds[n]}`).join(', ');
            this.log.warn(`[${id}] Channel command failed (${summary}): ${err.message || err}`);
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
            throw new Error('setPosition requires Type=Shutter and a configured motor runtime (>0s) for this channel');
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
            this.log.info(`[${id}] ch${chNum}: position unknown - reference run (${refCmd}, ${Math.round(travel / 1000)}s) before moving to ${target}%`);
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
            this.log.debug(`[${id}] ch${chNum}: difference ${deltaPct}% would give ${remainingMs}ms < API minimum ${MIN_TIMED_MS}ms - no movement`);
            await this.setStateAsync(`${id}.channels.ch${chNum}.setPosition`, { val: current, ack: true });
            return;
        }

        while (remainingMs > 0) {
            if (aborted()) {
                this.log.debug(`[${id}] ch${chNum}: setPosition sequence aborted`);
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
        this.log.debug(`[${id}] ch${chNum}: target position ${target}% reached (estimate)`);
    }

    // ------------------------------------------------------- statische Infos

    async refreshStaticInfo(id) {
        const dev = this.devices[id];
        try {
            const idData = await this.zrapGet(id, '/zrap/id');

            // Verifikation: antwortet hier wirklich ein zeptrion-Gerät?
            if (idData.sys !== undefined && String(idData.sys).toUpperCase() !== 'ZEPTRION') {
                this.log.warn(`[${id}] Host ${dev.cfg.host} responds, but reports sys="${idData.sys}" instead of "ZEPTRION" - likely wrong IP or not a zeptrion device!`);
            }
            // Plausibilisierung: Kanalzahl aus dem Gerätetyp ableiten (3340-4-x = 4, 3340-2-x = 2)
            const typeStr = String(idData.type ?? '');
            const m = typeStr.match(/^3340-(\d)-/);
            if (m) {
                const hwChannels = parseInt(m[1], 10);
                if (hwChannels !== dev.cfg.channels) {
                    this.log.warn(`[${id}] Device type ${typeStr} has ${hwChannels} channels, ${dev.cfg.channels} configured - please correct in the instance configuration.`);
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
                            common: { name: {
                                en: `Channel ${n} - ${chName}`, de: `Kanal ${n} - ${chName}`, ru: `Канал ${n} - ${chName}`,
                                pt: `Canal ${n} - ${chName}`, nl: `Kanaal ${n} - ${chName}`, fr: `Canal ${n} - ${chName}`,
                                it: `Canale ${n} - ${chName}`, es: `Canal ${n} - ${chName}`, pl: `Kanał ${n} - ${chName}`,
                                uk: `Канал ${n} - ${chName}`, 'zh-cn': `通道 ${n} - ${chName}`
                            } }
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
            this.log.debug(`[${id}] optional service ${path} unavailable/failed: ${err.message || err}`);
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
        this.log.info(`[${id}] Device time synchronized: ${rfc1123} (tz=${tz})`);
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
                this.log.debug(`[${id}] Smartfront (zapi) unavailable: ${err.message || err}`);
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
            if (!was) this.log.info(`Device ${id} (${dev.cfg.host}) is reachable.`);
        } else {
            dev.fails++;
            this.setStateChangedAsync(`${id}.info.connection`, { val: false, ack: true });
            if (was) this.log.warn(`Device ${id} (${dev.cfg.host}) no longer reachable.`);
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
        if (code === 'ECONNREFUSED') msg = 'Connection refused (device off or wrong IP?)';
        else if (code === 'ECONNABORTED') msg = 'Timeout (device not reachable)';
        else if (code === 'EHOSTUNREACH') msg = 'Host unreachable (check network/routing)';
        else if (code === 'ENOTFOUND') msg = 'Hostname/mDNS name could not be resolved';
        else if (code === 'ETIMEDOUT') msg = 'Timeout while establishing the connection';
        this.log.warn(`[${id}] Error during ${context}: ${msg}`);
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
                this.log.warn(`Error in onStateChange(${rel}): ${err.message || err}`);
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
                    this.log.warn(`[${id}] Factory reset unlocked for 30 seconds.`);
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
                            this.log.error(`[${id}] Factory reset REJECTED: set ${id}.system.unlock first (30s window). Otherwise the device incl. WLAN configuration would be wiped and drop off the network.`);
                            await this.setStateAsync(idFull, { val: false, ack: true });
                            return;
                        }
                        dev.unlockUntil = 0;
                        this.log.warn(`[${id}] FACTORY RESET is being executed - device will lose all settings incl. WLAN!`);
                    }
                    await this.zrapPost(id, '/zrap/sys', { cmd });
                    this.log.info(`[${id}] System command sent: ${cmd}`);
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
                    throw new Error(`ledSet: not valid JSON ("${err.message}"). Example: [{"id":2,"bg":"#220000"}]`);
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
                    this.log.warn(`[${id}] posEstimate is now read-only. Use "calibrate" to calibrate, "setPosition" to move.`);
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
                        this.log.warn(`[${id}] Tilt pulse not configured (set "Tilt pulse (ms)" in the device table, typically 300-800ms for slats).`);
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
                reject(new Error('Module "bonjour-service" is not installed. Run "npm install bonjour-service" in the adapter directory.'));
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
                    this.log.debug(`Discovery: unexpected/foreign mDNS packet ignored (${err.message || err})`);
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
                        this.log.debug(`Discovery: fallback filter (_http._tcp) error ignored (${err.message || err})`);
                    }
                });
                // Auch auf explizite Fehler-Events der Browser reagieren, statt sie
                // als unhandled 'error' durchfallen zu lassen.
                if (browserNew && typeof browserNew.on === 'function') {
                    browserNew.on('error', err => this.log.debug(`Discovery (_zapp._tcp) error: ${err.message || err}`));
                }
                if (browserOld && typeof browserOld.on === 'function') {
                    browserOld.on('error', err => this.log.debug(`Discovery (_http._tcp) error: ${err.message || err}`));
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
                    if (obj.callback) this.sendTo(obj.from, obj.command, { result: I18n.translate('csvFieldEmpty') }, obj.callback);
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
                    if (existingHosts.has(row.host.toLowerCase())) errs.push({ key: 'hostAlreadyConfigured', args: [] });
                    if (errs.length) {
                        report.push(I18n.translate('csvRowError', i + 1, row.host || '?', this.renderValidationErrorsLocalized(errs)));
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
                    report.push(I18n.translate('csvRowImported', i + 1, row.name || row.host, row.host, candidate));
                    added++;
                }

                if (added > 0 && instObj) {
                    instObj.native.devices = devices;
                    await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
                }
                const restartHint = added ? I18n.translate('csvImportRestartHint') : '';
                const result = I18n.translate('csvImportSummary', added, lines.length, restartHint, report.join('\n'));
                this.log.info(`CSV import: ${added}/${lines.length} rows imported`);
                if (obj.callback) this.sendTo(obj.from, obj.command, { result }, obj.callback);
            } catch (err) {
                // Log entry stays English regardless of system language; the UI-facing message
                // is localized separately via I18n.translate().
                this.log.warn(`CSV import failed: ${err.message || err}`);
                const msg = I18n.translate('csvImportFailed', err.message || err);
                if (obj.callback) this.sendTo(obj.from, obj.command, { error: msg }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testDevices') {
            const devicesCfg = Array.isArray(this.config.devices) ? this.config.devices : [];
            const rows = devicesCfg.filter(d => d && d.host);
            if (!rows.length) {
                if (obj.callback) this.sendTo(obj.from, obj.command, { result: I18n.translate('noDevicesWithHost') }, obj.callback);
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
                        lines.push(I18n.translate('testInvalidIp', label, host));
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
                        const ch = m ? I18n.translate('testChannelsSuffix', m[1]) : '';
                        lines.push(I18n.translate('testDeviceOk', label, host, idData.type ?? '?', ch, idData.sw ?? '?', idData.sn ?? '?'));
                    } else {
                        lines.push(I18n.translate('testNotZeptrion', label, host, idData.sys ?? 'unknown'));
                    }
                } catch (err) {
                    const code = err.code || (err.message || '').substring(0, 40);
                    lines.push(I18n.translate('testUnreachable', label, host, code));
                }
            }
            const result = lines.join('\n');
            this.log.info(`Device test: ${lines.length} device(s) checked`);
            if (obj.callback) this.sendTo(obj.from, obj.command, { result }, obj.callback);
            return;
        }

        if (obj.command === 'discover') {
            try {
                this.log.info('Starting mDNS discovery for zeptrion devices...');
                const results = await this.discoverDevices(4000);
                const added = await this.mergeDiscoveredDevices(results);
                // Log entry stays English regardless of system language; the UI-facing message
                // is localized separately via I18n.translate().
                this.log.info(`Discovery finished: ${results.length} device(s) found on the network, ${added} newly added (disabled).`);
                const msg = I18n.translate('discoveryFinished', results.length, added);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { result: msg, devices: results }, obj.callback);
                }
            } catch (err) {
                const msg = err.message || String(err);
                this.log.warn(`Discovery failed: ${msg}`);
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
