const CREDENTIALS = {
    clientId: "",
    clientSecret: "",
    refreshToken: "",
};

const CONFIG = {
    resolutions: ["2160p", "1080p", "720p", "480p", "Unknown"],
    qualities: [
        "BluRay REMUX",
        "BluRay",
        "WEB-DL",
        "WEBRip",
        "HDRip",
        "HC HD-Rip",
        "DVDRip",
        "HDTV",
        "CAM",
        "TS",
        "TC",
        "SCR",
        "Unknown",
    ],
    visualTags: ["HDR10+", "HDR10", "HDR", "DV", "IMAX", "AI"],
    sortBy: ["resolution", "visualTag", "size", "quality"],
    showAudioFiles: false,
    considerHdrTagsAsEqual: true,
    addonName: "GDrive",
    prioritiseLanguage: null,
    proxiedPlayback: false,
    strictTitleCheck: false,
    tmdbApiKey: null,
    enableSearchCatalog: true,
    enableVideoCatalog: true,
    maxFilesToFetch: 1000,

    // ── Límits del pla gratuït de Cloudflare Workers ──────────────────────
    // Free: 50 subpeticions externes per invocació (les crides a la Cache API
    // comparteixen la mateixa quota). Per això NO podem resoldre TMDB per a
    // totes les carpetes a cada càrrega del catàleg: resolem unes poques per
    // petició i les desem en un mapa persistent. Al cap de 3-4 refrescs el
    // catàleg queda complet i, a partir d'aquí, carrega instantàniament.
    // Si passes al pla de pagament (10.000 subpeticions) pots pujar-ho molt.
    maxResolucionsPerPeticio: 12,
    // Durada del mapa a la memòria cau (segons). 7 dies.
    mapaTtlSegons: 604800,
    driveQueryTerms: {
        episodeFormat: "fullText",
        titleName: "name",
    },
    driveFolderIds: [],

    // ── Catàleg de "col·leccions" propi (afegit per gestionar carpetes amb
    // noms/estructura inconsistents que no segueixen convencions Sxx/Eyy) ──
    // Cada subcarpeta DIRECTA d'aquests ids es mostra com una sèrie pròpia al
    // catàleg. El contingut de cada subcarpeta es recorre en viu a cada
    // petició de meta, així que sèries/episodis nous apareixen sols sense
    // haver de tocar aquesta llista.
    enableCollectionsCatalog: true,
    // "Pelis" (té subcarpetes que són sèries, ex. Bola de Drac, One Piece) i
    // "Series" (unitat compartida "Animelliure t7").
    collectionsRootFolderIds: [
        "1gFvLogJwAqobE_7Km4uC6zEkt-FyOEC3", // Series
    ],
    // Carpetes de les quals els arxius DIRECTES (no dins subcarpetes) es
    // mostren com a pel·lícules soltes al catàleg "gdrive_list" existent.
    moviesFolderIds: [
        "1G8ZZTxqrsx1bU-oDf-IyLRnLUVPSxYo-", // Pelis
    ],
};

const MANIFEST = {
    id: "stremio.gdrive.worker.cat",
    version: "1.0.0",
    name: CONFIG.addonName,
    description: "Stream your files from Google Drive within Stremio!",
    catalogs: [],
    resources: [
        {
            name: "stream",
            types: ["movie", "series", "anime"],
        },
    ],
    types: ["movie", "series"],
};

// Mapping IMDB ID → GDrive folder/file per streams
const IMDB_TO_GDRIVE = new Map(); // "tt1234567" → { type: "series"|"movie", id: "folderId/fileId" }
// Cache TMDB per evitar crides repetides i rate limiting
const TMDB_CACHE = new Map(); // "nom_netejat" → { poster, background, imdbId, tmdbType }
// Cache de l'estructura de temporades: imdbId → [n_eps_T1, n_eps_T2, ...]
const SEASON_STRUCTURE_CACHE = new Map();
// Cache de títols alternatius: imdbId → ["Dragon Ball", "Bola de Drac", ...]
const TITLES_CACHE = new Map();

// ── Pressupost de subpeticions ────────────────────────────────────────────
// El pla gratuït permet 50 subpeticions externes per invocació. Portem el
// compte per aturar-nos abans d'esgotar-lo i retornar sempre una resposta
// vàlida, encara que sigui parcial, en lloc de petar amb "Too many subrequests".
let PRESSUPOST = 50;
function reiniciaPressupost(n = 46) { PRESSUPOST = n; }
function consumeix(n = 1) {
    if (PRESSUPOST - n < 0) return false;
    PRESSUPOST -= n;
    return true;
}
function quedaPressupost(minim = 3) { return PRESSUPOST > minim; }

// ── Mapa persistent carpeta/fitxer → metadades ────────────────────────────
// Tot el mapa es desa en UN sol objecte a la Cache API: llegir-lo costa una
// única subpetició en comptes d'una per títol, que és el que feia inviable
// resoldre el catàleg sencer dins dels límits.
const MAPA_URL = "https://gdrive-addon.local/__mapa_v1";
let MAPA = null;          // { [clau]: { imdbId, poster, background, title, ts } }
let MAPA_BRUT = false;    // hi ha canvis pendents de desar?

async function carregaMapa() {
    if (MAPA) return MAPA;
    MAPA = {};
    try {
        if (typeof caches === "undefined") return MAPA;
        if (!consumeix(1)) return MAPA;
        const resposta = await caches.default.match(new Request(MAPA_URL));
        if (resposta) {
            MAPA = await resposta.json();
            console.log({ message: "Mapa carregat", entrades: Object.keys(MAPA).length });
        }
    } catch (e) {
        console.error({ message: "No s'ha pogut carregar el mapa", error: e.toString() });
    }
    return MAPA;
}

async function desaMapa(ctx) {
    if (!MAPA_BRUT || !MAPA) return;
    try {
        if (typeof caches === "undefined") return;
        const resposta = new Response(JSON.stringify(MAPA), {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": `max-age=${CONFIG.mapaTtlSegons}`,
            },
        });
        const promesa = caches.default.put(new Request(MAPA_URL), resposta);
        // waitUntil deixa que la escriptura acabi després de respondre a
        // l'usuari: el catàleg no s'espera a que es desi el mapa.
        if (ctx?.waitUntil) ctx.waitUntil(promesa); else await promesa;
        MAPA_BRUT = false;
    } catch (e) {
        console.error({ message: "No s'ha pogut desar el mapa", error: e.toString() });
    }
}

function llegeixMapa(clau) {
    return MAPA?.[clau] || null;
}

function escriuMapa(clau, valor) {
    if (!MAPA) MAPA = {};
    MAPA[clau] = { ...valor, ts: Date.now() };
    MAPA_BRUT = true;
}

// Limitar concurrència per no superar rate limits de TMDB (~40 req/10s)
async function processInBatches(items, fn, batchSize = 5, delayMs = 250) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
        if (i + batchSize < items.length) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return results;
}

const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
};

const API_ENDPOINTS = {
    DRIVE_FETCH_FILES: "https://content.googleapis.com/drive/v3/files",
    DRIVE_FETCH_FILE: "https://content.googleapis.com/drive/v3/files/{fileId}",
    DRIVE_STREAM_FILE:
        "https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&file_name={filename}",
    DRIVE_TOKEN: "https://oauth2.googleapis.com/token",
    CINEMETA: "https://v3-cinemeta.strem.io/meta/{type}/{id}.json",
    IMDB_SUGGEST: "https://v3.sg.media-imdb.com/suggestion/a/{id}.json",
    TMDB_FIND:
        "https://api.themoviedb.org/3/find/{id}?api_key={apiKey}&external_source=imdb_id",
    TMDB_DETAILS: "https://api.themoviedb.org/3/{type}/{id}?api_key={apiKey}",
    TMDB_SEARCH: "https://api.themoviedb.org/3/search/multi?api_key={apiKey}&query={query}&page=1",
    TMDB_EXTERNAL_IDS: "https://api.themoviedb.org/3/{type}/{id}/external_ids?api_key={apiKey}",
    TMDB_TV: "https://api.themoviedb.org/3/tv/{id}?api_key={apiKey}&language={lang}",
};

const REGEX_PATTERNS = {
    validStreamRequest: /\/stream\/(movie|series)\/([a-zA-Z0-9%:\-_]+)\.json/,
    validPlaybackRequest: /\/playback\/([a-zA-Z0-9%:\-_]+)\/(.+)/,
    validCatalogRequest:
        /\/catalog\/(movie|series)\/([a-zA-Z0-9%:\-_]+)(\/search=(.+))?\.json/,
    validMetaRequest: /\/meta\/(movie|series)\/([a-zA-Z0-9%:\-_]+)\.json/,
    resolutions: {
        "2160p": /(?<![^ [(_\-.])(4k|2160p|uhd)(?=[ \)\]_.-]|$)/i,
        "1080p": /(?<![^ [(_\-.])(1080p|fhd)(?=[ \)\]_.-]|$)/i,
        "720p": /(?<![^ [(_\-.])(720p|hd)(?=[ \)\]_.-]|$)/i,
        "480p": /(?<![^ [(_\-.])(480p|sd)(?=[ \)\]_.-]|$)/i,
    },
    qualities: {
        "BluRay REMUX":
            /(?<![^ [(_\-.])((blu[ .\-_]?ray|bd|br|b|uhd)[ .\-_]?remux)(?=[ \)\]_.-]|$)/i,
        BluRay: /(?<![^ [(_\-.])(blu[ .\-_]?ray|((bd|br|b|uhd)[ .\-_]?(rip|r)?))(?![ .\-_]?remux)(?=[ \)\]_.-]|$)/i,
        "WEB-DL":
            /(?<![^ [(_\-.])(web[ .\-_]?(dl)?)(?![ .\-_]?DLRip)(?=[ \)\]_.-]|$)/i,
        WEBRip: /(?<![^ [(_\-.])(web[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
        HDRip: /(?<![^ [(_\-.])(hd[ .\-_]?rip|web[ .\-_]?dl[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
        "HC HD-Rip": /(?<![^ [(_\-.])(hc|hd[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
        DVDRip: /(?<![^ [(_\-.])(dvd[ .\-_]?(rip|mux|r|full|5|9))(?=[ \)\]_.-]|$)/i,
        HDTV: /(?<![^ [(_\-.])((hd|pd)tv|tv[ .\-_]?rip|hdtv[ .\-_]?rip|dsr(ip)?|sat[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
        CAM: /(?<![^ [(_\-.])(cam|hdcam|cam[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
        TS: /(?<![^ [(_\-.])(telesync|ts|hd[ .\-_]?ts|pdvd|predvd(rip)?)(?=[ \)\]_.-]|$)/i,
        TC: /(?<![^ [(_\-.])(telecine|tc|hd[ .\-_]?tc)(?=[ \)\]_.-]|$)/i,
        SCR: /(?<![^ [(_\-.])(((dvd|bd|web)?[ .\-_]?)?(scr(eener)?))(?=[ \)\]_.-]|$)/i,
    },
    visualTags: {
        "HDR10+":
            /(?<![^ [(_\-.])(hdr[ .\-_]?(10|ten)[ .\-_]?([+]|plus))(?=[ \)\]_.-]|$)/i,
        HDR10: /(?<![^ [(_\-.])(hdr10)(?=[ \)\]_.-]|$)/i,
        HDR: /(?<![^ [(_\-.])(hdr)(?=[ \)\]_.-]|$)/i,
        DV: /(?<![^ [(_\-.])(dolby[ .\-_]?vision(?:[ .\-_]?atmos)?|dv)(?=[ \)\]_.-]|$)/i,
        IMAX: /(?<![^ [(_\-.])(imax)(?=[ \)\]_.-]|$)/i,
        AI: /(?<![^ [(_\-.])(ai[ .\-_]?(upscale|enhanced|remaster))(?=[ \)\]_.-]|$)/i,
    },
    audioTags: {
        Atmos: /(?<![^ [(_\-.])(atmos)(?=[ \)\]_.-]|$)/i,
        "DD+": /(?<![^ [(_\-.])((?:ddp|dolby[ .\-_]?digital[ .\-_]?plus)(?:[ .\-_]?(5\.1|7\.1))?)(?=[ \)\]_.-]|$)/i,
        DD: /(?<![^ [(_\-.])((?:dd|dolby[ .\-_]?digital)(?:[ .\-_]?(5\.1|7\.1))?)(?=[ \)\]_.-]|$)/i,
        "DTS-HD MA":
            /(?<![^ [(_\-.])(dts[ .\-_]?hd[ .\-_]?ma)(?=[ \)\]_.-]|$)/i,
        "DTS-HD":
            /(?<![^ [(_\-.])(dts[ .\-_]?hd)(?![ .\-_]?ma)(?=[ \)\]_.-]|$)/i,
        DTS: /(?<![^ [(_\-.])(dts(?![ .\-_]?hd[ .\-_]?ma|[ .\-_]?hd))(?=[ \)\]_.-]|$)/i,
        TrueHD: /(?<![^ [(_\-.])(true[ .\-_]?hd)(?=[ \)\]_.-]|$)/i,
        5.1: /(?<![^ [(_\-.])((?:ddp|dd)?[ .\-_]?5\.1)(?=[ \)\]_.-]|$)/i,
        7.1: /(?<![^ [(_\-.])((?:ddp|dd)?[ .\-_]?7\.1)(?=[ \)\]_.-]|$)/i,
        AC3: /(?<![^ [(_\-.])(ac[ .\-_]?3)(?=[ \)\]_.-]|$)/i,
        AAC: /(?<![^ [(_\-.])(aac)(?=[ \)\]_.-]|$)/i,
    },
    encodes: {
        HEVC: /(?<![^ [(_\-.])(hevc|x265|h265|h\.265)(?=[ \)\]_.-]|$)/i,
        AVC: /(?<![^ [(_\-.])(avc|x264|h264|h\.264)(?=[ \)\]_.-]|$)/i,
    },
    languages: {
        Multi: /(?<![^ [(_\-.])(multi|multi[ .\-_]?audio)(?=[ \)\]_.-]|$)/i,
        "Dual Audio": /(?<![^ [(_\-.])(dual[ .\-_]?audio)(?=[ \)\]_.-]|$)/i,
        English: /(?<![^ [(_\-.])(english|eng)(?=[ \)\]_.-]|$)/i,
        Japanese: /(?<![^ [(_\-.])(japanese|jap)(?=[ \)\]_.-]|$)/i,
        Chinese: /(?<![^ [(_\-.])(chinese|chi)(?=[ \)\]_.-]|$)/i,
        Russian: /(?<![^ [(_\-.])(russian|rus)(?=[ \)\]_.-]|$)/i,
        Arabic: /(?<![^ [(_\-.])(arabic|ara)(?=[ \)\]_.-]|$)/i,
        Portuguese: /(?<![^ [(_\-.])(portuguese|por)(?=[ \)\]_.-]|$)/i,
        Spanish: /(?<![^ [(_\-.])(spanish|spa)(?=[ \)\]_.-]|$)/i,
        French: /(?<![^ [(_\-.])(french|fra)(?=[ \)\]_.-]|$)/i,
        German: /(?<![^ [(_\-.])(german|ger)(?=[ \)\]_.-]|$)/i,
        Italian: /(?<![^ [(_\-.])(italian|ita)(?=[ \)\]_.-]|$)/i,
        Korean: /(?<![^ [(_\-.])(korean|kor)(?=[ \)\]_.-]|$)/i,
        Hindi: /(?<![^ [(_\-.])(hindi|hin)(?=[ \)\]_.-]|$)/i,
        Bengali: /(?<![^ [(_\-.])(bengali|ben)(?=[ \)\]_.-]|$)/i,
        Punjabi: /(?<![^ [(_\-.])(punjabi|pan)(?=[ \)\]_.-]|$)/i,
        Marathi: /(?<![^ [(_\-.])(marathi|mar)(?=[ \)\]_.-]|$)/i,
        Gujarati: /(?<![^ [(_\-.])(gujarati|guj)(?=[ \)\]_.-]|$)/i,
        Tamil: /(?<![^ [(_\-.])(tamil|tam)(?=[ \)\]_.-]|$)/i,
        Telugu: /(?<![^ [(_\-.])(telugu|tel)(?=[ \)\]_.-]|$)/i,
        Kannada: /(?<![^ [(_\-.])(kannada|kan)(?=[ \)\]_.-]|$)/i,
        Malayalam: /(?<![^ [(_\-.])(malayalam|mal)(?=[ \)\]_.-]|$)/i,
        Thai: /(?<![^ [(_\-.])(thai|tha)(?=[ \)\]_.-]|$)/i,
        Vietnamese: /(?<![^ [(_\-.])(vietnamese|vie)(?=[ \)\]_.-]|$)/i,
        Indonesian: /(?<![^ [(_\-.])(indonesian|ind)(?=[ \)\]_.-]|$)/i,
        Turkish: /(?<![^ [(_\-.])(turkish|tur)(?=[ \)\]_.-]|$)/i,
        Hebrew: /(?<![^ [(_\-.])(hebrew|heb)(?=[ \)\]_.-]|$)/i,
        Persian: /(?<![^ [(_\-.])(persian|per)(?=[ \)\]_.-]|$)/i,
        Ukrainian: /(?<![^ [(_\-.])(ukrainian|ukr)(?=[ \)\]_.-]|$)/i,
        Greek: /(?<![^ [(_\-.])(greek|ell)(?=[ \)\]_.-]|$)/i,
        Lithuanian: /(?<![^ [(_\-.])(lithuanian|lit)(?=[ \)\]_.-]|$)/i,
        Latvian: /(?<![^ [(_\-.])(latvian|lav)(?=[ \)\]_.-]|$)/i,
        Estonian: /(?<![^ [(_\-.])(estonian|est)(?=[ \)\]_.-]|$)/i,
        Polish: /(?<![^ [(_\-.])(polish|pol)(?=[ \)\]_.-]|$)/i,
        Czech: /(?<![^ [(_\-.])(czech|cze)(?=[ \)\]_.-]|$)/i,
        Slovak: /(?<![^ [(_\-.])(slovak|slo)(?=[ \)\]_.-]|$)/i,
        Hungarian: /(?<![^ [(_\-.])(hungarian|hun)(?=[ \)\]_.-]|$)/i,
        Romanian: /(?<![^ [(_\-.])(romanian|rum)(?=[ \)\]_.-]|$)/i,
        Bulgarian: /(?<![^ [(_\-.])(bulgarian|bul)(?=[ \)\]_.-]|$)/i,
        Serbian: /(?<![^ [(_\-.])(serbian|srp)(?=[ \)\]_.-]|$)/i,
        Croatian: /(?<![^ [(_\-.])(croatian|hrv)(?=[ \)\]_.-]|$)/i,
        Slovenian: /(?<![^ [(_\-.])(slovenian|slv)(?=[ \)\]_.-]|$)/i,
        Dutch: /(?<![^ [(_\-.])(dutch|dut)(?=[ \)\]_.-]|$)/i,
        Danish: /(?<![^ [(_\-.])(danish|dan)(?=[ \)\]_.-]|$)/i,
        Finnish: /(?<![^ [(_\-.])(finnish|fin)(?=[ \)\]_.-]|$)/i,
        Swedish: /(?<![^ [(_\-.])(swedish|swe)(?=[ \)\]_.-]|$)/i,
        Norwegian: /(?<![^ [(_\-.])(norwegian|nor)(?=[ \)\]_.-]|$)/i,
        Malay: /(?<![^ [(_\-.])(malay|may)(?=[ \)\]_.-]|$)/i,
    },
};

function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1000;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(durationMillis) {
    const seconds = Math.floor(durationMillis / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const formattedSeconds = seconds % 60;
    const formattedMinutes = minutes % 60;

    return `${hours}:${formattedMinutes}:${formattedSeconds}`;
}

function createJsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 4), {
        headers: HEADERS,
        status: status,
    });
}

function compareLanguages(a, b) {
    if (CONFIG.prioritiseLanguage) {
        const aHasPrioritisedLanguage = a.languages.includes(
            CONFIG.prioritiseLanguage
        );
        const bHasPrioritisedLanguage = b.languages.includes(
            CONFIG.prioritiseLanguage
        );
        const aHasMultiLanguage = a.languages.includes("Multi");
        const bHasMultiLanguage = b.languages.includes("Multi");

        if (aHasPrioritisedLanguage && !bHasPrioritisedLanguage) return -1;
        if (!aHasPrioritisedLanguage && bHasPrioritisedLanguage) return 1;

        if (aHasMultiLanguage && !bHasMultiLanguage) return -1;
        if (!aHasMultiLanguage && bHasMultiLanguage) return 1;
    }
    return 0;
}

function compareByField(a, b, field) {
    if (field === "resolution") {
        return (
            CONFIG.resolutions.indexOf(a.resolution) -
            CONFIG.resolutions.indexOf(b.resolution)
        );
    } else if (field === "size") {
        return b.size - a.size;
    } else if (field === "quality") {
        return (
            CONFIG.qualities.indexOf(a.quality) -
            CONFIG.qualities.indexOf(b.quality)
        );
    } else if (field === "visualTag") {
        // Find the highest priority visual tag in each file
        const getIndexOfTag = (tag) =>
            CONFIG.considerHdrTagsAsEqual && tag.startsWith("HDR")
                ? CONFIG.visualTags.indexOf("HDR10+")
                : CONFIG.visualTags.indexOf(tag);
        const aVisualTagIndex = a.visualTags.reduce(
            (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
            CONFIG.visualTags.length
        );

        const bVisualTagIndex = b.visualTags.reduce(
            (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
            CONFIG.visualTags.length
        );
        // Sort by the visual tag index
        return aVisualTagIndex - bVisualTagIndex;
    } else if (field === "durationAsc") {
        return a.duration - b.duration;
    } else if (field === "durationDesc") {
        return b.duration - a.duration;
    }
    return 0;
}

// Treu del nom d'un fitxer el títol "net" de l'episodi: sense extensió, sense
// etiquetes tècniques i sense el patró de numeració, per poder mostrar-lo tal
// qual a Stremio (ex. "One Piece - 01x01 - ¡Yo soy Luffy!.mkv" → "¡Yo soy Luffy!")
function titolEpisodiDeNom(nomArxiu, titolsSerie = []) {
    let t = nomArxiu
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .replace(/\[.*?\]/g, " ")
        .replace(/\((?:[^)]*(?:\d{3,4}p|cat|esp|eng|jap|sub|dub|FLAC|DTS|AVC|BD|HD)[^)]*)\)/gi, " ")
        .replace(SXE_REGEX, " ")
        .replace(NXM_REGEX, " ")
        .replace(TEMPORADA_EP_REGEX, " ")
        .replace(EP_EXPLICIT_REGEX, " ")
        .replace(/\b\d{3,4}p\b/gi, " ")
        .replace(/\b(?:x26[45]|h\.?26[45]|HEVC|AVC|AAC|FLAC|DTS|AC3|DD[P+]?\d?(?:\.\d)?|Atmos|DoVi|HDR\d*)\b/gi, " ")
        .replace(/\b(?:BluRay|BDRemux|BDRip|WEB-?DL|WEBRip|HDRip|DVDRip|HDTV|REMUX|UHD)\b/gi, " ")
        .replace(/[-_.]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    // Treu el nom de la sèrie del davant: volem NOMÉS el títol de l'episodi
    for (const titol of titolsSerie) {
        if (!titol) continue;
        const esc = titol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        t = t.replace(new RegExp("^\\s*" + esc + "\\s*[-–:_]*\\s*", "i"), "").trim();
    }
    t = t.replace(/^[-–:_\s]+/, "").trim();
    // I el número d'episodi que sovint queda al davant ("031 El Gran Torneig")
    t = t.replace(/^\d{1,4}\s*[-–:_]*\s*/, "").trim();

    // Si després de netejar només queden números o queda buit, no serveix
    if (!t || /^[\d\s]*$/.test(t)) return null;
    return t;
}

function createStream(parsedFile, accessToken, epInfo = null) {
    // Nom: títol de l'episodi + SxxEyy (punt simple i llegible).
    // Per pel·lícules o quan no hi ha info d'episodi, el nom mostra la qualitat.
    let name;
    if (epInfo) {
        const codi = `S${String(epInfo.season).padStart(2, "0")}E${String(epInfo.episode).padStart(2, "0")}`;
        const titol = epInfo.title ? `${epInfo.title} · ${codi}` : codi;
        name = `${titol}\n${parsedFile.resolution}`;
    } else {
        name = parsedFile.type.startsWith("audio")
            ? `[🎵] ${parsedFile.extension?.toUpperCase() || "Audio"}`
            : `${MANIFEST.name} ${parsedFile.resolution}`;
    }

    // Descripció: pistes d'àudio i duració en primer lloc, com has demanat.
    const linies = [];
    if (parsedFile.languages.length > 0) {
        linies.push(`🔊 ${parsedFile.languages.join(" · ")}`);
    }
    if (parsedFile.duration) {
        linies.push(`⏱️ ${formatDuration(parsedFile.duration)}`);
    }
    const tecnic = [
        parsedFile.quality !== "Unknown" ? parsedFile.quality : null,
        parsedFile.encode || null,
        ...parsedFile.visualTags,
        ...parsedFile.audioTags,
    ].filter(Boolean);
    if (tecnic.length > 0) linies.push(`🎞️ ${tecnic.join(" · ")}`);
    linies.push(`📦 ${parsedFile.formattedSize}`);

    let description = linies.join("\n");
    const combinedTags = [
        parsedFile.resolution,
        parsedFile.quality,
        parsedFile.encode,
        ...parsedFile.visualTags,
        ...parsedFile.audioTags,
        ...parsedFile.languages,
    ];

    const stream = {
        name: name,
        description: description,
        url: "",
        behaviorHints: {
            videoSize: parseInt(parsedFile.size) || 0,
            filename: parsedFile.name,
            bingeGroup: `${MANIFEST.name}|${combinedTags.join("|")}`,
        },
    };

    if (CONFIG.proxiedPlayback) {
        stream.url = `${globalThis.playbackUrl}/${
            parsedFile.id
        }/${encodeURIComponent(parsedFile.name)}`;
    } else {
        stream.url = API_ENDPOINTS.DRIVE_STREAM_FILE.replace(
            "{fileId}",
            parsedFile.id
        ).replace("{filename}", parsedFile.name);
        stream.behaviorHints.proxyHeaders = {
            request: {
                Accept: "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
        };
        stream.behaviorHints.notWebReady = true;
    }

    return stream;
}

function createErrorStream(description) {
    return {
        name: `[⚠️] ${MANIFEST.name}`,
        description: description,
        externalUrl: "https://github.com/Viren070/stremio-gdrive-addon",
    };
}

function sortParsedFiles(parsedFiles) {
    parsedFiles.sort((a, b) => {
        const languageComparison = compareLanguages(a, b);
        if (languageComparison !== 0) return languageComparison;

        for (const sortByField of CONFIG.sortBy) {
            const fieldComparison = compareByField(a, b, sortByField);
            if (fieldComparison !== 0) return fieldComparison;
        }

        // move audio files to the end
        if (a.type.startsWith("audio") && !b.type.startsWith("audio")) return 1;
        if (!a.type.startsWith("audio") && b.type.startsWith("audio"))
            return -1;

        return 0;
    });
}

function parseAndFilterFiles(files) {
    return files
        .map((file) => parseFile(file))
        .filter(
            (parsedFile) =>
                CONFIG.resolutions.includes(parsedFile.resolution) &&
                CONFIG.qualities.includes(parsedFile.quality) &&
                parsedFile.visualTags.every((tag) =>
                    CONFIG.visualTags.includes(tag)
                )
        );
}

function parseFile(file) {
    let resolution =
        Object.entries(REGEX_PATTERNS.resolutions).find(([_, pattern]) =>
            pattern.test(file.name)
        )?.[0] || "Unknown";
    let quality =
        Object.entries(REGEX_PATTERNS.qualities).find(([_, pattern]) =>
            pattern.test(file.name)
        )?.[0] || "Unknown";
    let visualTags = Object.entries(REGEX_PATTERNS.visualTags)
        .filter(([_, pattern]) => pattern.test(file.name))
        .map(([tag]) => tag);
    let audioTags = Object.entries(REGEX_PATTERNS.audioTags)
        .filter(([_, pattern]) => pattern.test(file.name))
        .map(([tag]) => tag);
    let encode =
        Object.entries(REGEX_PATTERNS.encodes).find(([_, pattern]) =>
            pattern.test(file.name)
        )?.[0] || "";
    let languages = Object.entries(REGEX_PATTERNS.languages)
        .filter(([_, pattern]) => pattern.test(file.name))
        .map(([tag]) => tag);

    if (visualTags.includes("HDR10+")) {
        visualTags = visualTags.filter(
            (tag) => tag !== "HDR" && tag !== "HDR10"
        );
    } else if (visualTags.includes("HDR10")) {
        visualTags = visualTags.filter((tag) => tag !== "HDR");
    }

    return {
        id: file.id,
        name: file.name.trim(),
        size: file.size,
        formattedSize: parseInt(file.size)
            ? formatSize(parseInt(file.size))
            : "Unknown",
        resolution: resolution,
        quality: quality,
        languages: languages,
        encode: encode,
        audioTags: audioTags,
        visualTags: visualTags,
        duration:
            parseInt(file.videoMediaMetadata?.durationMillis) || undefined,
        type: file.mimeType,
        extension: file.fileExtension,
    };
}

function isConfigValid() {
    const requiredFields = [
        {
            value: CREDENTIALS.clientId,
            error: "Missing clientId. Add your client ID to the credentials object",
        },
        {
            value: CREDENTIALS.clientSecret,
            error: "Missing clientSecret! Add your client secret to the credentials object",
        },
        {
            value: CREDENTIALS.refreshToken,
            error: "Missing refreshToken! Add your refresh token to the credentials object",
        },
        {
            value: CONFIG.addonName,
            error: "Missing addonName! Provide it in the config object",
        },
    ];

    for (const { value, error } of requiredFields) {
        if (!value) {
            console.error({ message: error, yourValue: value });
            return false;
        }
    }

    const validValues = {
        resolutions: [...Object.keys(REGEX_PATTERNS.resolutions), "Unknown"],
        qualities: [...Object.keys(REGEX_PATTERNS.qualities), "Unknown"],
        sortBy: [
            "resolution",
            "size",
            "quality",
            "visualTag",
            "durationAsc",
            "durationDesc",
        ],
        languages: [...Object.keys(REGEX_PATTERNS.languages), "Unknown"],
        visualTags: [...Object.keys(REGEX_PATTERNS.visualTags)],
    };

    const keyToSingular = {
        resolutions: "resolution",
        qualities: "quality",
        sortBy: "sort criterion",
        visualTags: "visual tag",
    };

    for (const key of ["resolutions", "qualities", "sortBy", "visualTags"]) {
        const configValue = CONFIG[key];
        if (!Array.isArray(configValue)) {
            console.error(`Invalid ${key}: ${configValue} is not an array`);
            return false;
        }
        for (const value of CONFIG[key]) {
            if (!validValues[key].includes(value)) {
                console.error({
                    message: `Invalid ${keyToSingular[key]}: ${value}`,
                    validValues: validValues[key],
                });
                return false;
            }
        }
    }

    if (
        CONFIG.prioritiseLanguage &&
        !validValues.languages.includes(CONFIG.prioritiseLanguage)
    ) {
        console.error({
            message: `Invalid prioritised language: ${CONFIG.prioritiseLanguage}`,
            validValues: validValues.languages,
        });
        return false;
    }

    return true;
}

async function getMetadata(type, fullId) {
    let id = fullId;

    if (id.startsWith("kitsu")) {
        id = id.split(":")[0] + ":" + id.split(":")[1]; // Remove the :1 at the end
        const meta = await getKitsuMeta(type, id);
        if (meta) {
            console.log({
                message: "Successfully retrieved metadata from Kitsu",
                meta,
            });
            return meta;
        }

        console.error({
            message: "Failed to get metadata from Kitsu, returning null",
        });

        return null;
    }


    if (CONFIG.tmdbApiKey) {
        try {
            const meta = await getTmdbMeta(type, fullId);
            if (meta) {
                console.log({
                    message: "Successfully retrieved metadata from TMDb",
                    meta,
                });
                return meta;
            }
        } catch (error) {
            console.error({
                message: "Error fetching metadata from TMDb",
                error: error.toString(),
            });
        }
    }
    try {
        const meta = await getCinemetaMeta(type, id);
        if (meta) {
            console.log({
                message: "Successfully retrieved metadata from Cinemeta",
                meta,
            });
            return meta;
        }
    } catch (error) {
        console.error({
            message: "Error fetching metadata from Cinemeta",
            error: error.toString(),
        });
    }

    try {
        const meta = await getImdbSuggestionMeta(id);
        if (meta) {
            console.log({
                message:
                    "Successfully retrieved metadata from IMDb Suggestions",
                meta,
            });
            return meta;
        }
    } catch (error) {
        console.error({
            message: "Error fetching metadata from IMDb Suggestions",
            error: error.toString(),
        });
    }

    console.error({
        message:
            "Failed to get metadata from Cinemeta or IMDb Suggestions, returning null",
    });
    return null;
}

async function getKitsuMeta(type, id) {
    console.log({ message: "Fetching metadata from Kitsu", type, id });
    const url = `https://anime-kitsu.strem.fun/meta/${type}/${id}.json`;
    console.log({ url });
    const response = await fetch(url);
    if (!response.ok) {
        let err = await response.text();
        throw new Error(err);
    }
    const data = await response.json();
    if (!data?.meta) {
        throw new Error("Meta object not found in response");
    }
    if (!data.meta.name || !data.meta.year) {
        throw new Error("Either name or year not found in meta object");
    }
    return {
        name: data.meta.name,
        year: data.meta.year,
    };
}

async function getTmdbMeta(type, id) {
    let response;
    let result;
    if (id.startsWith("tmdb")) {
        if (!CONFIG.tmdbApiKey) {
            throw new Error("TMDB ID detected but no API key provided");
        }
        const url = API_ENDPOINTS.TMDB_DETAILS.replace("{type}", type === "movie" ? "movie" : "tv")
            .replace("{id}", id.split(":")[1])
            .replace("{apiKey}", CONFIG.tmdbApiKey);
        console.log({
            message: "Fetching data from TMDB with TMDB ID",
            url,
        });
        response = await fetch(url);

        if (!response.ok) {
            let err = await response.text();
            throw new Error(`${response.status} - ${response.statusText}: ${err}`);
        }

        result = await response.json();

    } else {
        const url = API_ENDPOINTS.TMDB_FIND.replace("{id}", id.split(":")[0])
            .replace("{apiKey}", CONFIG.tmdbApiKey)
        console.log({
            message: "Fetching data from TMDB with external source",
            url,
        })
        response = await fetch(url);

        if (!response.ok) {
            let err = await response.text();
            throw new Error(`${response.status} - ${response.statusText}: ${err}`);
        }
        const data = await response.json();
        if (!data?.movie_results && !data?.tv_results) {
            throw new Error("No results found in response");
        }
    
        result = data.movie_results[0] || data.tv_results[0];

    }
    
    if (!result) {
        throw new Error("No results found in response");
    }
    console.log({ message: "Got data from TMDB", result });

    if (
        (!result.name && !result.title) ||
        (!result.release_date && !result.first_air_date)
    ) {
        throw new Error("Either title or release date not found in result");
    }

    return {
        name: result.name || result.title,
        year: (result.release_date || result.first_air_date).split("-")[0],
        poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
        background: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : null,
        logo: result.logo_path ? `https://image.tmdb.org/t/p/w300${result.logo_path}` : null,
    };
}

function cleanTitleForSearch(name) {
    const originalTitleMatch = name.match(/\(([A-Z][A-Za-z][\w\s:!?'&\-,.]{2,})\)/);
    const originalTitle = originalTitleMatch && 
        !/(?:FLAC|DTS|cat|esp|eng|jap|val|cas|mal|sub|dub|BD|HD|AVC)/i.test(originalTitleMatch[1])
        ? originalTitleMatch[1].trim() : null;
    
    let cleanedName = name
        .replace(/\.[a-z0-9]{3,4}$/i, "")
        .replace(/\[.*?\]/g, "")
        .replace(/\((\d{4})\)/g, "")
        .replace(/\([^)]*\d{4}[^)]*\)/g, "")
        .replace(/\([^)]*(?:cat|esp|eng|jap|sub|dub|FLAC|DTS|AVC|BD|HD|by\s)[^)]*\)/gi, "")
        .replace(/\b\d{3,4}p\b/gi, "")
        .replace(/\b(?:BDRemux|BluRay|WEB-?DL|WEBRip|HDRip|DVDRip|HDTV|CAM|REMUX|UHD|4K)\b/gi, "")
        .replace(/\b(?:x264|x265|h264|h265|HEVC|AVC|AAC|FLAC|DTS|Atmos|AC3|DoVi|HDR\d*)\b/gi, "")
        .replace(/\b(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL)(?:\s*[-]\s*(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL))*\b/g, "")
        .replace(/\b(?:cat|esp|eng|jap|val|cas|mal)\b/gi, "")
        .replace(/\bby\s+\w+/gi, "")
        .replace(/\bv\d+\b/gi, "")
        .replace(/\s*M\d+\s*/g, " ")
        .replace(/\bREEL\d+\b/gi, "")
        .replace(/\b\d+th\s+Anniversary\b/gi, "")
        .replace(/\d+-\d+/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const yearMatch = name.match(/\((\d{4})\)/);
    const year = yearMatch ? yearMatch[1] : null;

    const queries = [];
    if (originalTitle) queries.push(originalTitle);
    if (cleanedName && cleanedName.length > 1) queries.push(cleanedName);

    return { queries, year };
}

async function getTmdbPosterByName(name, { preferTv = false } = {}) {
    if (!CONFIG.tmdbApiKey) return null;

    const cacheKey = (preferTv ? "tv:" : "any:") + name.toLowerCase().trim();
    if (TMDB_CACHE.has(cacheKey)) return TMDB_CACHE.get(cacheKey);

    const { queries, year } = cleanTitleForSearch(name);
    if (queries.length === 0) return null;

    const normalitza = (t) => (t || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ").trim();

    function puntua(result, consulta) {
        const cand = [result.name, result.title, result.original_name, result.original_title]
            .filter(Boolean).map(normalitza);
        const q = normalitza(consulta);
        if (cand.includes(q)) return 3;
        if (cand.some((c) => c.startsWith(q) || q.startsWith(c))) return 2;
        if (cand.some((c) => c.includes(q) || q.includes(c))) return 1;
        return 0;
    }

    try {
        // Només UNA cerca. El paràmetre include_adult=false i language=ca-ES
        // ja retorna els títols catalans/castellans quan existeixen, i TMDB
        // casa prou bé els títols traduïts sense haver de provar idioma per
        // idioma. Això baixa de ~16 subpeticions per títol a 2, que és el que
        // fa que el catàleg càpiga dins dels límits del pla gratuït.
        const endpoint = preferTv ? "tv" : "multi";
        const q = queries[0];

        const params = new URLSearchParams({
            api_key: CONFIG.tmdbApiKey,
            query: q,
            page: "1",
            include_adult: "false",
            language: "ca-ES",
        });
        if (year) params.set(endpoint === "tv" ? "first_air_date_year" : "year", year);

        if (!consumeix(1)) return null;
        const res = await fetch(`https://api.themoviedb.org/3/search/${endpoint}?${params}`);
        if (!res.ok) {
            TMDB_CACHE.set(cacheKey, null);
            return null;
        }
        const data = await res.json();
        const results = data.results || [];

        let millor = null;
        for (const r of results.slice(0, 6)) {
            const mt = r.media_type || (endpoint === "tv" ? "tv" : "movie");
            if (preferTv && mt === "movie") continue;
            const score = puntua(r, q);
            if (score === 0) continue;
            if (!millor || score > millor.score) millor = { result: { ...r, media_type: mt }, score };
            if (score === 3) break;
        }
        // Si res no puntua però hi ha un únic resultat clar, l'acceptem
        if (!millor && results.length > 0) {
            const r = results[0];
            const mt = r.media_type || (endpoint === "tv" ? "tv" : "movie");
            if (!(preferTv && mt === "movie")) millor = { result: { ...r, media_type: mt }, score: 0 };
        }
        if (!millor) {
            TMDB_CACHE.set(cacheKey, null);
            return null;
        }

        const result = millor.result;

        // Segona i última subpetició: l'ID d'IMDB, que és el que permet que
        // AIOMetadata aporti descripció, logo i episodis.
        let imdbId = null;
        if (quedaPressupost(2) && consumeix(1)) {
            try {
                const mediaType = result.media_type === "movie" ? "movie" : "tv";
                const extUrl = API_ENDPOINTS.TMDB_EXTERNAL_IDS
                    .replace("{type}", mediaType)
                    .replace("{id}", result.id)
                    .replace("{apiKey}", CONFIG.tmdbApiKey);
                const extRes = await fetch(extUrl);
                if (extRes.ok) imdbId = (await extRes.json()).imdb_id || null;
            } catch (e) { /* ignore */ }
        }

        const out = {
            poster: imdbId
                ? `https://btttr.cc/poster-n/imdb/poster-default/${imdbId}.jpg`
                : (result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null),
            background: result.backdrop_path
                ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}`
                : null,
            imdbId,
            tmdbId: result.id,
            tmdbType: result.media_type,
            title: result.name || result.title || null,
            score: millor.score,
        };
        TMDB_CACHE.set(cacheKey, out);
        return out;
    } catch (e) {
        console.error({ message: "getTmdbPosterByName ha fallat", name, error: e.toString() });
        return null;
    }
}

async function getCinemetaMeta(type, id) {
    id = id.split(":")[0];
    const response = await fetch(
        API_ENDPOINTS.CINEMETA.replace("{type}", type).replace("{id}", id)
    );
    if (!response.ok) {
        let err = await response.text();
        throw new Error(err);
    }
    const data = await response.json();
    if (!data?.meta) {
        throw new Error("Meta object not found in response");
    }
    if (!data.meta.name || !data.meta.year) {
        throw new Error("Either name or year not found in meta object");
    }
    return {
        name: data.meta.name,
        year: data.meta.year,
    };
}

async function getImdbSuggestionMeta(id) {
    id = id.split(":")[0];
    const response = await fetch(
        API_ENDPOINTS.IMDB_SUGGEST.replace("{id}", id)
    );
    if (!response.ok) {
        let err = await response.text();
        throw new Error(err);
    }
    const data = await response.json();
    if (!data?.d) {
        throw new Error("No suggestions in d object");
    }

    const item = data.d.find((item) => item.id === id);
    if (!item) {
        throw new Error("No matching item found with the given id");
    }

    if (!item?.l || !item?.y) {
        throw new Error("Missing name or year");
    }

    return {
        name: item.l,
        year: item.y,
    };
}

async function getAccessToken() {
    consumeix(1);
    const params = new URLSearchParams({
        client_id: CREDENTIALS.clientId,
        client_secret: CREDENTIALS.clientSecret,
        refresh_token: CREDENTIALS.refreshToken,
        grant_type: "refresh_token",
    });

    try {
        const response = await fetch(API_ENDPOINTS.DRIVE_TOKEN, {
            method: "POST",
            body: params,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });

        if (!response.ok) {
            let err = await response.json();
            throw new Error(JSON.stringify(err));
        }

        const { access_token } = await response.json();
        return access_token;
    } catch (error) {
        console.error({
            message: "Failed to refresh token",
            error: JSON.parse(error.message),
        });
        return undefined;
    }
}

async function fetchFiles(fetchUrl, accessToken) {
    consumeix(1);
    try {
        const response = await fetch(fetchUrl.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
            let err = await response.text();
            throw new Error(err);
        }
        // handle paginated results

        const results = await response.json();
        console.log({
            message: "Initial search yielded results",
            numItems: results.files.length,
        });
        while (results.nextPageToken) {
            fetchUrl.searchParams.set("pageToken", results.nextPageToken);
            const nextPageResponse = await fetch(fetchUrl.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (!nextPageResponse.ok) {
                let err = await nextPageResponse.text();
                throw new Error(err);
            }

            const nextPageResults = await nextPageResponse.json();
            results.files = [...results.files, ...nextPageResults.files];
            results.nextPageToken = nextPageResults.nextPageToken;
            console.log({
                message: "Searched next page",
                nextPageResults: nextPageResults.files.length,
                nextPageToken: nextPageResults.nextPageToken,
                totalResults: results.files.length,
            });
            if (results.files.length >= CONFIG.maxFilesToFetch) {
                console.log({
                    message: "Reached maximum number of files",
                    files: results.files.length,
                });
                break;
            }
            if (nextPageResults.files.length === 0) {
                console.log({ message: "No more files to fetch" });
                break;
            }
        }

        return results;
    } catch (error) {
        console.error({
            message: "Could not fetch files from Google Drive",
            error: error.toString(),
        });
        return null;
    }
}

async function fetchFile(fileId, accessToken) {
    try {
        const fetchUrl = new URL(
            API_ENDPOINTS.DRIVE_FETCH_FILE.replace("{fileId}", fileId)
        );
        const searchParams = {
            supportsAllDrives: true,
            fields: "id,name,mimeType,size,videoMediaMetadata,fileExtension,createdTime,thumbnailLink,iconLink",
        };
        fetchUrl.search = new URLSearchParams(searchParams).toString();
        const response = await fetch(fetchUrl.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
            let err = await response.text();
            throw new Error(err);
        }

        const file = await response.json();
        return file;
    } catch (error) {
        console.error({
            message: "Could not fetch file from Google Drive",
            error: error.toString(),
        });
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CATÀLEG DE "COL·LECCIONS" — carpetes amb episodis sense convenció fiable
//  de nom (Sxx/Eyy). En lloc de buscar per text a l'hora de reproduir, es
//  recorre la carpeta un cop en construir el meta i es guarda directament
//  l'id del fitxer de Drive a cada episodi — el stream es resol després pel
//  camí "gdrive:<fileId>" ja existent, sense necessitat de cap cerca.
// ═══════════════════════════════════════════════════════════════════════════

const FOLDER_MIME = "application/vnd.google-apps.folder";
const VIDEO_EXT_REGEX = /\.(mkv|mp4|avi|m4v|mov|wmv|ts)$/i;

async function listChildren(folderId, accessToken, { onlyFolders = false, onlyFiles = false } = {}) {
    consumeix(1);
    let q = `'${folderId}' in parents and trashed = false`;
    if (onlyFolders) q += ` and mimeType = '${FOLDER_MIME}'`;
    if (onlyFiles) q += ` and mimeType != '${FOLDER_MIME}'`;

    const items = [];
    let pageToken;
    do {
        const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
        const params = {
            q,
            corpora: "allDrives",
            includeItemsFromAllDrives: "true",
            supportsAllDrives: "true",
            pageSize: "1000",
            // name_natural: ordenació alfanumèrica "natural" (ex. "2" abans
            // que "10"), imprescindible perquè l'assignació de temporada/
            // episodi no depengui de l'ordre arbitrari que dona Drive per
            // defecte quan no s'especifica orderBy.
            orderBy: "name_natural",
            fields: "nextPageToken,files(id,name,mimeType,size,videoMediaMetadata,fileExtension,thumbnailLink,createdTime)",
        };
        if (pageToken) params.pageToken = pageToken;
        fetchUrl.search = new URLSearchParams(params).toString();

        const response = await fetch(fetchUrl.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(err);
        }
        const data = await response.json();
        items.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);

    return items;
}

async function walkCollectionFiles(rootFolderId, accessToken, maxDepth = 6) {
    const resultats = [];

    async function recorre(folderId, ruta, profunditat) {
        if (profunditat > maxDepth) return;
        // Si ens quedem sense pressupost de subpeticions, parem: val més
        // retornar els fitxers trobats fins ara que no pas fallar del tot.
        if (!quedaPressupost(4)) {
            console.log({ message: "Pressupost exhaurit recorrent la col·lecció", ruta });
            return;
        }
        const fills = await listChildren(folderId, accessToken);
        for (const item of fills) {
            if (item.mimeType === FOLDER_MIME) {
                await recorre(item.id, [...ruta, item.name], profunditat + 1);
            } else if (VIDEO_EXT_REGEX.test(item.name)) {
                resultats.push({ file: item, ruta: [...ruta, item.name] });
            }
        }
    }

    await recorre(rootFolderId, [], 0);
    return resultats;
}

const SXE_REGEX = /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i;
const NXM_REGEX = /\b(\d{1,2})x(\d{1,3})\b/i;
const TEMPORADA_EP_REGEX = /\b(?:temporada|season|saga|temp|st)[\s._-]*(\d{1,2})[\s._-]*(?:cap[íi]tol|episodi|episode|ep|cap)[\s._-]*(\d{1,3})\b/i;
const EP_EXPLICIT_REGEX = /\b(?:cap[íi]tol|episodi|episode|ep|cap)[\s._-]*(\d{1,3})\b/i;
// Número solt: prioritza el que està separat per guions/espais (ex. "Bola de Drac - 042 - Títol")
const NUMERO_SEPARAT_REGEX = /(?:^|[\s._-])(\d{1,3})(?=[\s._-]|$)/;
const NUMERO_PLA_REGEX = /(\d{1,4})(?!\d)/;

// Treu de l'anàlisi trossos del nom que contenen números que NO són episodis
// (resolucions, anys, codecs, mides) per evitar falsos positius.
function netejaSorollNumeric(nom) {
    return nom
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .replace(/\[.*?\]/g, " ")
        .replace(/\b\d{3,4}p\b/gi, " ")
        .replace(/\b(?:19|20)\d{2}\b/g, " ")
        .replace(/\bx26[45]\b/gi, " ")
        .replace(/\bh\.?26[45]\b/gi, " ")
        .replace(/\b\d+(?:\.\d+)?\s*(?:GB|MB|kbps|fps|bit)\b/gi, " ")
        .replace(/\b(?:AC3|DTS|AAC|FLAC|DD)\s*\d?(?:\.\d)?\b/gi, " ")
        .replace(/\b\d+\s*ch\b/gi, " ")
        .replace(/\b4K\b/gi, " ");
}

function extreuNumeroEpisodi(nomArxiu) {
    const net = netejaSorollNumeric(nomArxiu);

    let m = SXE_REGEX.exec(net);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), font: "SxE" };

    m = TEMPORADA_EP_REGEX.exec(net);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), font: "SxE" };

    m = NXM_REGEX.exec(net);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), font: "NxM" };

    m = EP_EXPLICIT_REGEX.exec(net);
    if (m) return { season: null, episode: parseInt(m[1], 10), font: "pla" };

    m = NUMERO_SEPARAT_REGEX.exec(net);
    if (m) return { season: null, episode: parseInt(m[1], 10), font: "pla" };

    m = NUMERO_PLA_REGEX.exec(net);
    if (m) return { season: null, episode: parseInt(m[1], 10), font: "pla" };

    return null;
}

// Obté quants episodis té cada temporada segons TMDB. Això és el que permet
// convertir una numeració absoluta (ex. One Piece 001..1100) a season/episode
// i viceversa, que és la causa principal del desordre d'episodis.
async function getSeasonStructure(imdbId) {
    if (SEASON_STRUCTURE_CACHE.has(imdbId)) return SEASON_STRUCTURE_CACHE.get(imdbId);
    if (!CONFIG.tmdbApiKey) return null;

    try {
        const findUrl = API_ENDPOINTS.TMDB_FIND
            .replace("{id}", imdbId)
            .replace("{apiKey}", CONFIG.tmdbApiKey);
        const findRes = await fetch(findUrl);
        if (!findRes.ok) return null;
        const findData = await findRes.json();
        const tv = findData.tv_results?.[0];
        if (!tv) {
            SEASON_STRUCTURE_CACHE.set(imdbId, null);
            return null;
        }

        const tvUrl = API_ENDPOINTS.TMDB_TV
            .replace("{id}", tv.id)
            .replace("{apiKey}", CONFIG.tmdbApiKey)
            .replace("{lang}", "en");
        const tvRes = await fetch(tvUrl);
        if (!tvRes.ok) return null;
        const tvData = await tvRes.json();

        // Comptes d'episodis per temporada, ignorant la temporada 0 (especials)
        const counts = [];
        for (const s of tvData.seasons || []) {
            if (s.season_number === 0) continue;
            counts[s.season_number] = s.episode_count || 0;
        }
        const structure = counts.length > 1 ? counts : null;
        SEASON_STRUCTURE_CACHE.set(imdbId, structure);
        return structure;
    } catch (e) {
        return null;
    }
}

// Converteix season/episode → número absolut fent servir l'estructura TMDB.
// Ex. amb T1=26 episodis, S02E05 → absolut 31.
function aAbsolut(season, episode, structure) {
    if (!structure) return null;
    let total = 0;
    for (let s = 1; s < season; s++) {
        if (structure[s] == null) return null;
        total += structure[s];
    }
    return total + episode;
}

// Treu el primer número que apareix en un nom de carpeta (ex. "Saga 02" -> 2,
// "Temporada 10" -> 10), per poder ordenar sagues/temporades correctament en
// lloc de dependre de l'ordre en què Drive les ha retornat.
function primerNumeroDe(text) {
    const m = /(\d{1,3})/.exec(text);
    return m ? parseInt(m[1], 10) : null;
}

function assignaEpisodis(fitxersRuta) {
    const ambNumero = [];
    const senseNumero = [];

    for (const item of fitxersRuta) {
        const nomArxiu = item.ruta[item.ruta.length - 1];
        const info = extreuNumeroEpisodi(nomArxiu);
        if (info) {
            ambNumero.push({ ...item, ...info });
        } else {
            senseNumero.push({ ...item, season: null, episode: null, font: "cap" });
        }
    }

    const ambSxE = ambNumero.filter((i) => i.font !== "pla");
    let episodis = [];

    if (ambNumero.length > 0 && ambSxE.length >= ambNumero.length * 0.5) {
        // Majoria amb format Sxx/Eyy explícit: fem servir season/episode tal
        // qual (season pot ser 0 per a "especials" — no ho col·lapsem a 1).
        // Els que només tenen número pla (minoria) es posen a temporada 1
        // al final, amb un número d'episodi alt perquè no col·lisionin.
        episodis = ambNumero
            .concat(senseNumero.map((i, idx) => ({ ...i, season: 1, episode: 9000 + idx })))
            .map((i) => ({
                file: i.file,
                season: i.season != null ? i.season : 1,
                episode: i.episode,
                title: i.ruta[i.ruta.length - 1],
            }));
    } else {
        // Numeració plana o inexistent: agrupem per la carpeta CONTENIDORA
        // real de cada arxiu (ruta sencera menys el nom de fitxer, no només
        // el primer nivell) — així funciona igual si els episodis són
        // directament dins la carpeta de la sèrie, o a qualsevol profunditat
        // (ex. "Bola de Drac [qualitat]/Saga 01/episodi.mkv": la clau
        // d'agrupació és "Bola de Drac [qualitat]/Saga 01", no només
        // "Bola de Drac [qualitat]", que agruparia totes les sagues juntes).
        const grups = new Map();
        for (const item of ambNumero.concat(senseNumero)) {
            const clau =
                item.ruta.length > 1
                    ? item.ruta.slice(0, -1).join("/")
                    : "__ARREL__";
            if (!grups.has(clau)) grups.set(clau, []);
            grups.get(clau).push(item);
        }

        // Ordenem els grups pel número que trobem al nom de la seva carpeta
        // (ex. "Saga 01" abans que "Saga 02"), i si cap no en té, alfabètic.
        const clausOrdenades = [...grups.keys()].sort((a, b) => {
            const nomA = a === "__ARREL__" ? "" : a.split("/").pop();
            const nomB = b === "__ARREL__" ? "" : b.split("/").pop();
            const numA = primerNumeroDe(nomA);
            const numB = primerNumeroDe(nomB);
            if (numA != null && numB != null && numA !== numB) return numA - numB;
            if (numA != null && numB == null) return -1;
            if (numA == null && numB != null) return 1;
            return nomA.localeCompare(nomB);
        });

        let numTemporada = 1;
        for (const clau of clausOrdenades) {
            const itemsGrup = grups.get(clau);
            itemsGrup.sort((a, b) => {
                if (a.episode != null && b.episode != null) return a.episode - b.episode;
                if (a.episode != null) return -1;
                if (b.episode != null) return 1;
                return a.ruta[a.ruta.length - 1].localeCompare(b.ruta[b.ruta.length - 1]);
            });
            // Conservem el número d'episodi real quan el tenim (evita que
            // afegir un episodi antic reordeni els números de tots els
            // altres al proper refresc); només inventem un número seqüencial
            // pels que no en tenen cap.
            let seguentSenseNumero =
                Math.max(0, ...itemsGrup.map((i) => i.episode).filter((e) => e != null)) + 1;
            itemsGrup.forEach((item) => {
                const numEpisodi = item.episode != null ? item.episode : seguentSenseNumero++;
                episodis.push({
                    file: item.file,
                    season: numTemporada,
                    episode: numEpisodi,
                    title: item.ruta[item.ruta.length - 1],
                });
            });
            numTemporada++;
        }
    }

    return episodis;
}

// Analitza tots els fitxers d'una col·lecció i n'extreu la informació
// d'episodi, incloent-hi el context de la carpeta contenidora (que sovint
// indica la temporada quan el nom del fitxer no ho fa).
function analitzaFitxers(fitxersRuta) {
    return fitxersRuta.map((item) => {
        const nomArxiu = item.ruta[item.ruta.length - 1];
        const info = extreuNumeroEpisodi(nomArxiu);
        // Temporada segons la carpeta contenidora (ex. "Temporada 2", "Saga 03")
        let seasonCarpeta = null;
        for (let i = item.ruta.length - 2; i >= 0; i--) {
            const carpeta = item.ruta[i];
            const m = /\b(?:temporada|season|saga|temp|t|s)[\s._-]*(\d{1,2})\b/i.exec(carpeta);
            if (m) { seasonCarpeta = parseInt(m[1], 10); break; }
            const soloNum = /^(\d{1,2})$/.exec(carpeta.trim());
            if (soloNum) { seasonCarpeta = parseInt(soloNum[1], 10); break; }
        }
        // Candidat secundari: el primer número "aïllat" del nom. Serveix quan
        // el nom conté tant una numeració absoluta com una paraula com
        // "episodi N" dins del títol de l'episodi.
        let numeroInicial = null;
        const mi = NUMERO_SEPARAT_REGEX.exec(netejaSorollNumeric(nomArxiu));
        if (mi) numeroInicial = parseInt(mi[1], 10);

        return {
            file: item.file,
            ruta: item.ruta,
            nomArxiu,
            season: info?.season ?? null,
            episode: info?.episode ?? null,
            font: info?.font ?? "cap",
            seasonCarpeta,
            numeroInicial,
        };
    });
}

// Troba els fitxers que corresponen a la temporada/episodi demanats.
// Prova diverses estratègies en ordre de fiabilitat i retorna la primera
// que doni resultats — així funciona tant si els fitxers estan numerats
// SxxEyy, com per temporada en carpetes, com amb numeració absoluta.
function trobaEpisodis(fitxersRuta, targetSeason, targetEpisode, structure) {
    const items = analitzaFitxers(fitxersRuta);
    const absolut = aAbsolut(targetSeason, targetEpisode, structure);

    // 1. SxxEyy explícit al nom del fitxer — el senyal més fiable
    let matches = items.filter(
        (i) => i.font !== "pla" && i.font !== "cap" &&
               i.season === targetSeason && i.episode === targetEpisode
    );
    if (matches.length) return { matches, estrategia: "SxE" };

    // 2. Temporada per carpeta + número d'episodi al fitxer
    matches = items.filter(
        (i) => i.seasonCarpeta === targetSeason && i.episode === targetEpisode
    );
    if (matches.length) return { matches, estrategia: "carpeta+ep" };

    // 3. Numeració absoluta (One Piece 001..1100) via estructura TMDB
    if (absolut != null) {
        matches = items.filter(
            (i) => (i.font === "pla" || i.season == null) &&
                   (i.episode === absolut || i.numeroInicial === absolut)
        );
        if (matches.length) return { matches, estrategia: "absolut" };
    }

    // 4. Sèrie d'una sola temporada (o carpeta plana): número directe
    if (targetSeason === 1) {
        matches = items.filter(
            (i) => (i.font === "pla" || i.season == null) &&
                   (i.episode === targetEpisode || i.numeroInicial === targetEpisode)
        );
        if (matches.length) return { matches, estrategia: "pla-T1" };
    }

    // 5. Últim recurs: qualsevol fitxer amb aquest número d'episodi,
    //    ordenant per posició dins la carpeta per donar el més probable primer
    matches = items.filter((i) => i.episode === targetEpisode);
    if (matches.length) return { matches, estrategia: "número-solt" };

    return { matches: [], estrategia: "cap" };
}

function buildBaseSearchQuery(query) {
    query = query.replace(/'/g, "\\'");
    let q = `name contains '${query}' and trashed=false and not name contains 'trailer' and not name contains 'sample'`;

    if (CONFIG.showAudioFiles) {
        q += ` and (mimeType contains 'video/' or mimeType contains 'audio/')`;
    } else {
        q += ` and mimeType contains 'video/'`;
    }

    if (CONFIG.driveFolderIds && CONFIG.driveFolderIds.length > 0) {
        const folderQueries = CONFIG.driveFolderIds.map(id => `'${id}' in parents`);
        q += ` and (${folderQueries.join(' or ')})`;
    }

    console.log({ message: "Built base search query", query: q });
    return q;
}

async function buildSearchQuery(streamRequest) {
    const { name, year } = streamRequest.metadata;

    let query =
        "trashed=false and not name contains 'trailer' and not name contains 'sample'";

    query += CONFIG.showAudioFiles
        ? ` and (mimeType contains 'video/' or mimeType contains 'audio/')`
        : ` and mimeType contains 'video/'`;

    if (CONFIG.driveFolderIds && CONFIG.driveFolderIds.length > 0) {
        const folderQueries = CONFIG.driveFolderIds.map(id => `'${id}' in parents`);
        query += ` and (${folderQueries.join(' or ')})`;
    }    

    const sanitisedName = name
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/'/g, "\\'");
    const nameWithoutApostrophes = name.replace(/[^a-zA-Z0-9\s]/g, "");

    if (streamRequest.type === "movie")
        query += ` and (${CONFIG.driveQueryTerms.titleName} contains '${sanitisedName} ${year}' or ${CONFIG.driveQueryTerms.titleName} contains '${nameWithoutApostrophes} ${year}')`;
    if (streamRequest.type === "series")
        query += ` and (${CONFIG.driveQueryTerms.titleName} contains '${sanitisedName}' or ${CONFIG.driveQueryTerms.titleName} contains '${nameWithoutApostrophes}')`;

    const season = streamRequest.season;
    const episode = streamRequest.episode;
    if (!season || !episode) return query;

    const formats = [];
    let zeroPaddedSeason = season.toString().padStart(2, "0");
    let zeroPaddedEpisode = episode.toString().padStart(2, "0");

    const getFormats = (season, episode) => {
        return [
            [`s${season}e${episode}`],
            [`s${season}`, `e${episode}`],
            [`s${season}.e${episode}`],
            [`${season}x${episode}`],
            [`s${season}xe${episode}`],
            [`season ${season}`, `episode ${episode}`],
            [`s${season}`, `ep${episode}`],
        ];
    };

    formats.push(...getFormats(season, episode));

    if (zeroPaddedSeason !== season.toString()) {
        formats.push(...getFormats(zeroPaddedSeason, episode));
    }

    if (zeroPaddedEpisode !== episode.toString()) {
        formats.push(...getFormats(season, zeroPaddedEpisode));
    }

    if (
        zeroPaddedSeason !== season.toString() &&
        zeroPaddedEpisode !== episode.toString()
    ) {
        formats.push(...getFormats(zeroPaddedSeason, zeroPaddedEpisode));
    }

    query += ` and (${formats
        .map(
            (formatList) =>
                `(${formatList
                    .map(
                        (format) =>
                            `${CONFIG.driveQueryTerms.episodeFormat} contains '${format}'`
                    )
                    .join(" and ")})`
        )
        .join(" or ")})`;

    return query;
}


// Diverses versions del mateix títol (qualitats/idiomes diferents) han de
// col·lapsar en UNA entrada de catàleg; les versions es veuran com a opcions
// de stream diferents en obrir-la. Deduplica per ID d'IMDB quan n'hi ha, i
// si no, pel títol netejat.
function dedupMetas(metas) {
    const vistos = new Map();
    for (const meta of metas) {
        if (!meta) continue;
        const clau = meta.id.startsWith("tt")
            ? meta.id
            : "nom:" + (cleanTitleForSearch(meta.name).queries[0] || meta.name).toLowerCase();
        const previ = vistos.get(clau);
        if (!previ) {
            vistos.set(clau, meta);
        } else if (!previ.poster && meta.poster) {
            // Ens quedem amb la versió que sí que té caràtula
            vistos.set(clau, meta);
        }
    }
    return [...vistos.values()];
}

async function handleRequest(request) {
    try {
        const url = new URL(
            decodeURIComponent(request.url).replace("%3A", ":")
        );
        globalThis.playbackUrl = url.origin + "/playback";

        if (url.pathname === "/manifest.json") {
            const manifest = MANIFEST;
            manifest.catalogs = [];
            // El recurs "stream" accepta IDs d'IMDB i Kitsu: així qualsevol
            // sèrie/pel·lícula oberta des d'AIOMetadata (o qualsevol altre
            // catàleg) ens demanarà streams, sense haver de passar pels
            // nostres catàlegs.
            manifest.resources = [
                {
                    name: "stream",
                    types: ["movie", "series", "anime"],
                    idPrefixes: ["tt", "kitsu:", "gdrive:", "gdriveshow:"],
                },
            ];
            if (CONFIG.enableSearchCatalog) {
                manifest.catalogs.push({
                    type: "movie",
                    id: "gdrive_list",
                    name: "Google Drive",
                });
            }
            if (CONFIG.enableVideoCatalog) {
                manifest.catalogs.push({
                    type: "movie",
                    id: "gdrive_search",
                    name: "Google Drive Search",
                    extra: [
                        {
                            name: "search",
                            isRequired: true,
                        },
                    ],
                });
            }
            if (
                CONFIG.enableCollectionsCatalog &&
                CONFIG.collectionsRootFolderIds &&
                CONFIG.collectionsRootFolderIds.length > 0
            ) {
                manifest.catalogs.push({
                    type: "series",
                    id: "gdrive_collections",
                    name: "Col·leccions",
                });
            }
            if (
                CONFIG.enableVideoCatalog ||
                CONFIG.enableSearchCatalog ||
                CONFIG.enableCollectionsCatalog
            ) {
                manifest.resources.push({
                    name: "catalog",
                    types: ["movie", "series"],
                });
                // IMPORTANT: només reclamem "meta" pels nostres IDs interns.
                // Les entrades amb ID d'IMDB les resol AIOMetadata, que és qui
                // aporta descripció, logo, noms i imatges dels episodis.
                manifest.resources.push({
                    name: "meta",
                    types: ["movie", "series"],
                    idPrefixes: ["gdrive:", "gdriveshow:"],
                });
            }
            return createJsonResponse(manifest);
        }

        if (url.pathname === "/")
            return Response.redirect(url.origin + "/manifest.json", 301);

        // Escalfa el mapa: resol tants títols com permeti el pressupost i et
        // diu quants en queden. Cridant-lo unes quantes vegades el catàleg
        // queda complet i, a partir d'aquí, carrega a l'instant.
        if (url.pathname === "/omplir") {
            const accessToken = await getAccessToken();
            if (!accessToken) return createJsonResponse({ error: "Credencials invàlides" }, 500);
            await carregaMapa();

            let resoltes = 0, pendents = 0, total = 0;

            for (const rootId of CONFIG.collectionsRootFolderIds) {
                let carpetes = [];
                try { carpetes = await listChildren(rootId, accessToken, { onlyFolders: true }); }
                catch (e) { continue; }
                total += carpetes.length;
                for (const folder of carpetes) {
                    if (llegeixMapa("s:" + folder.id)) continue;
                    if (!quedaPressupost(6)) { pendents++; continue; }
                    const tmdb = await getTmdbPosterByName(folder.name, { preferTv: true });
                    escriuMapa("s:" + folder.id, tmdb
                        ? { imdbId: tmdb.imdbId, poster: tmdb.poster, background: tmdb.background, title: tmdb.title }
                        : { imdbId: null, poster: null, background: null, title: null });
                    resoltes++;
                }
            }

            await desaMapa(null);   // aquí sí que esperem l'escriptura
            const jaAlMapa = Object.keys(MAPA || {}).length;
            return createJsonResponse({
                missatge: pendents > 0
                    ? "Encara queden títols per resoldre. Torna a carregar /omplir."
                    : "Mapa complet.",
                totalCarpetes: total,
                resoltesAquestaVegada: resoltes,
                pendents,
                entradesAlMapa: jaAlMapa,
            });
        }

        // Buida el mapa (per si vols refer-lo de zero)
        if (url.pathname === "/buidar") {
            try { await caches.default.delete(new Request(MAPA_URL)); } catch (e) {}
            return createJsonResponse({ missatge: "Mapa esborrat." });
        }

        const streamMatch = REGEX_PATTERNS.validStreamRequest.exec(
            url.pathname
        );
        const playbackMatch = REGEX_PATTERNS.validPlaybackRequest.exec(
            url.pathname
        );
        const catalogMatch = REGEX_PATTERNS.validCatalogRequest.exec(
            url.pathname
        );
        const metaMatch = REGEX_PATTERNS.validMetaRequest.exec(url.pathname);

        if (!(playbackMatch || streamMatch || catalogMatch || metaMatch))
            return new Response("Bad Request", { status: 400 });

        if (!isConfigValid()) {
            return createJsonResponse({
                streams: [
                    createErrorStream(
                        "Invalid configuration\nEnable and check the logs for more information\nClick for setup instructions"
                    ),
                ],
            });
        }

        if (playbackMatch) {
            console.log({
                message: "Processing playback request",
                fileId: playbackMatch[1],
                range: request.headers.get("Range"),
            });
            const filename = decodeURIComponent(playbackMatch[2]);
            const fileId = playbackMatch[1];
            return createProxiedStreamResponse(fileId, filename, request);
        }

        const createMetaObject = async (id, name, size, thumbnail, createdTime, { permetResoldre = true } = {}) => {
            let dades = llegeixMapa("m:" + id);
            if (!dades && permetResoldre && quedaPressupost(6)) {
                const tmdb = await getTmdbPosterByName(name);
                dades = tmdb
                    ? { imdbId: tmdb.imdbId, poster: tmdb.poster, background: tmdb.background, title: tmdb.title }
                    : { imdbId: null, poster: null, background: null, title: null };
                escriuMapa("m:" + id, dades);
            }
            if (dades?.imdbId) {
                IMDB_TO_GDRIVE.set(dades.imdbId, { type: "movie", id });
            }
            return {
                id: dades?.imdbId ? dades.imdbId : `gdrive:${id}`,
                name: dades?.title || name,
                type: "movie",
                posterShape: "poster",
                poster: dades?.poster || thumbnail || null,
                background: dades?.background || thumbnail || null,
                description:
                    `Mida: ${formatSize(size)}` +
                    (createdTime
                        ? ` · Afegit: ${new Date(createdTime).toLocaleDateString("ca-ES", {
                              year: "numeric", month: "long", day: "numeric",
                          })}`
                        : ""),
            };
        };

        if (metaMatch) {
            const fullMetaId = metaMatch[2];
            if (!fullMetaId) {
                console.error({
                    message: "Failed to extract file ID",
                    error: "File ID is undefined",
                });
                return null;
            }

            if (fullMetaId.startsWith("gdriveshow:")) {
                const folderId = fullMetaId.split(":")[1];
                const accessToken = await getAccessToken();
                if (!accessToken) {
                    console.error({
                        message: "Failed to get access token",
                        error: "Access token is undefined",
                    });
                    return null;
                }
                console.log({ message: "Collection meta request", folderId });
                let folderInfo;
                let fitxersRuta;
                try {
                    [folderInfo, fitxersRuta] = await Promise.all([
                        fetchFile(folderId, accessToken),
                        walkCollectionFiles(folderId, accessToken),
                    ]);
                } catch (error) {
                    console.error({
                        message: "Failed to walk collection folder",
                        error: error.toString(),
                    });
                    return createJsonResponse({ meta: null }, 500);
                }
                const episodis = assignaEpisodis(fitxersRuta);
                const videos = episodis.map((ep) => ({
                    id: `gdrive:${ep.file.id}`,
                    season: ep.season,
                    episode: ep.episode,
                    title: titolEpisodiDeNom(ep.title, [folderInfo?.name])
                        || `Episodi ${ep.episode}`,
                    released: ep.file.createdTime || undefined,
                }));
                console.log({
                    message: "Collection meta built",
                    folderId,
                    numVideos: videos.length,
                });
                return createJsonResponse({
                    meta: {
                        id: fullMetaId,
                        type: "series",
                        name: folderInfo?.name || "Col·lecció",
                        posterShape: "poster",
                        videos,
                    },
                });
            }

            const gdriveId = fullMetaId.split(":")[1];
            const accessToken = await getAccessToken();
            if (!accessToken) {
                console.error({
                    message: "Failed to get access token",
                    error: "Access token is undefined",
                });
                return null;
            }
            console.log({ message: "Meta request", fullMetaId, gdriveId });
            const file = await fetchFile(gdriveId, accessToken);
            if (!file) {
                console.error({
                    message: "Failed to fetch file",
                    error: "File is undefined",
                });
                return null;
            }
            console.log({ message: "File fetched", file });
            const parsedFile = parseFile(file);
            return createJsonResponse({
                meta: await createMetaObject(
                    parsedFile.id,
                    parsedFile.name,
                    parsedFile.size,
                    file.thumbnailLink,
                    file.createdTime
                ),
            });
        }

        if (catalogMatch) {
            // handle catalogs
            const catalogId = catalogMatch[2];
            const searchQuery = catalogMatch[3];
            const searchTerm = searchQuery ? searchQuery.split("=")[1] : null;

            console.log({ message: "Catalog request", catalogId, searchTerm });

            if (catalogId === "gdrive_collections") {
                const accessToken = await getAccessToken();
                if (!accessToken) {
                    return createJsonResponse({
                        error: "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
                    });
                }
                await carregaMapa();

                // 1r pas: llistar carpetes (poques subpeticions)
                const carpetes = [];
                for (const rootId of CONFIG.collectionsRootFolderIds) {
                    try {
                        const subfolders = await listChildren(rootId, accessToken, { onlyFolders: true });
                        carpetes.push(...subfolders);
                    } catch (error) {
                        console.error({ message: "No s'han pogut llistar les col·leccions", error: error.toString() });
                    }
                }

                // 2n pas: separar les que ja tenim resoltes de les pendents
                const jaResoltes = [];
                const pendents = [];
                for (const folder of carpetes) {
                    const cau = llegeixMapa("s:" + folder.id);
                    if (cau) jaResoltes.push({ folder, dades: cau });
                    else pendents.push(folder);
                }

                // 3r pas: resoldre només un grapat de pendents per petició,
                // mentre quedi pressupost de subpeticions
                let resoltesAra = 0;
                for (const folder of pendents) {
                    if (resoltesAra >= CONFIG.maxResolucionsPerPeticio) break;
                    if (!quedaPressupost(6)) break;
                    const tmdb = await getTmdbPosterByName(folder.name, { preferTv: true });
                    const dades = tmdb
                        ? { imdbId: tmdb.imdbId, poster: tmdb.poster, background: tmdb.background, title: tmdb.title }
                        : { imdbId: null, poster: null, background: null, title: null };
                    escriuMapa("s:" + folder.id, dades);
                    jaResoltes.push({ folder, dades });
                    resoltesAra++;
                }

                // 4t pas: construir les entrades. Les que encara no s'han
                // resolt es mostren igualment (amb el nom de la carpeta),
                // i es resoldran en els propers refrescs.
                const metas = [];
                const resoltesIds = new Set(jaResoltes.map((x) => x.folder.id));
                for (const { folder, dades } of jaResoltes) {
                    if (dades.imdbId) {
                        IMDB_TO_GDRIVE.set(dades.imdbId, { type: "series", id: folder.id });
                        metas.push({
                            id: dades.imdbId,
                            type: "series",
                            name: dades.title || folder.name,
                            posterShape: "poster",
                            poster: dades.poster || null,
                            background: dades.background || null,
                        });
                    } else {
                        metas.push({
                            id: `gdriveshow:${folder.id}`,
                            type: "series",
                            name: folder.name,
                            posterShape: "poster",
                            poster: dades.poster || null,
                            background: dades.background || null,
                        });
                    }
                }
                for (const folder of carpetes) {
                    if (resoltesIds.has(folder.id)) continue;
                    metas.push({
                        id: `gdriveshow:${folder.id}`,
                        type: "series",
                        name: folder.name,
                        posterShape: "poster",
                    });
                }

                const metasFinals = dedupMetas(metas);
                console.log({
                    message: "Catàleg de col·leccions",
                    carpetes: carpetes.length,
                    jaAlMapa: carpetes.length - pendents.length,
                    resoltesAra,
                    pendents: pendents.length - resoltesAra,
                    metas: metasFinals.length,
                    pressupostRestant: PRESSUPOST,
                });
                await desaMapa(globalThis.__ctx);
                return createJsonResponse({ metas: metasFinals });
            }

            if (catalogId === "gdrive_list") {
                const parts = [
                    "trashed=false",
                    "mimeType contains 'video/'"
                ];
                const movieFolderIds =
                    CONFIG.moviesFolderIds && CONFIG.moviesFolderIds.length > 0
                        ? CONFIG.moviesFolderIds
                        : CONFIG.driveFolderIds;
                if (movieFolderIds && movieFolderIds.length > 0) {
                    const ors = movieFolderIds.map(id => `'${id}' in parents`);
                    parts.push(`(${ors.join(" or ")})`);
                }

                const queryParams = {
                    q: parts.join(" and "),
                    corpora: "allDrives",
                    includeItemsFromAllDrives: "true",
                    supportsAllDrives: "true",
                    pageSize: "1000",
                    orderBy: "createdTime desc",
                    fields: "nextPageToken,incompleteSearch,files(id,name,size,videoMediaMetadata,mimeType,fileExtension,thumbnailLink,createdTime)",
                };

                const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
                fetchUrl.search = new URLSearchParams(queryParams).toString();

                const accessToken = await getAccessToken();

                if (!accessToken) {
                    return createJsonResponse({
                        error: "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
                    });
                }

                const results = await fetchFiles(fetchUrl, accessToken);
                await carregaMapa();

                let resoltesAra = 0;
                const totsMetas = [];
                for (const file of results.files) {
                    const potResoldre =
                        resoltesAra < CONFIG.maxResolucionsPerPeticio && quedaPressupost(6);
                    const abans = PRESSUPOST;
                    totsMetas.push(await createMetaObject(
                        file.id, file.name, file.size, file.thumbnailLink, file.createdTime,
                        { permetResoldre: potResoldre }
                    ));
                    if (PRESSUPOST < abans) resoltesAra++;
                }

                const metas = dedupMetas(totsMetas);
                console.log({
                    message: "Catàleg de pel·lícules",
                    fitxers: results.files.length,
                    resoltesAra,
                    metas: metas.length,
                    pressupostRestant: PRESSUPOST,
                });
                await desaMapa(globalThis.__ctx);
                return createJsonResponse({ metas });
            }

            if (catalogId === "gdrive_search") {
                if (!searchTerm) {
                    return createJsonResponse({ metas: [] });
                }

                const queryParams = {
                    q: buildBaseSearchQuery(decodeURIComponent(searchTerm)),
                    corpora: "allDrives",
                    includeItemsFromAllDrives: "true",
                    supportsAllDrives: "true",
                    pageSize: "1000",
                    fields: "files(id,name,size,videoMediaMetadata,mimeType,fileExtension,thumbnailLink,createdTime)",
                };

                const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
                fetchUrl.search = new URLSearchParams(queryParams).toString();

                const accessToken = await getAccessToken();

                if (!accessToken) {
                    return createJsonResponse({
                        error: "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
                    });
                }

                const results = await fetchFiles(fetchUrl, accessToken);

                if (!results?.files || results.files.length === 0) {
                    return createJsonResponse({ metas: [] });
                }

                await carregaMapa();
                let resoltesAra = 0;
                const totsMetas = [];
                for (const file of results.files.slice(0, 60)) {
                    const potResoldre =
                        resoltesAra < CONFIG.maxResolucionsPerPeticio && quedaPressupost(6);
                    const abans = PRESSUPOST;
                    totsMetas.push(await createMetaObject(
                        file.id, file.name, file.size, file.thumbnailLink, file.createdTime,
                        { permetResoldre: potResoldre }
                    ));
                    if (PRESSUPOST < abans) resoltesAra++;
                }
                const metas = dedupMetas(totsMetas);
                await desaMapa(globalThis.__ctx);

                return createJsonResponse({ metas });
            }

            return createJsonResponse({ metas: [] });
        }

        const type = streamMatch[1];

        const fullId = streamMatch[2];
        let [season, episode] = fullId.split(":").slice(-2);
        console.log({
            message: "Stream request",
            type,
            fullId,
            season,
            episode,
        });
        if (fullId.startsWith("kitsu")) {
            season = 1;
        }

        if (fullId.startsWith("gdrive")) {
            const fileId = streamMatch[2].split(":")[1];
            const accessToken = await getAccessToken();
            if (!accessToken) {
                console.error({
                    message: "Failed to get access token",
                    error: "Access token is undefined",
                });
                return null;
            }

            const file = await fetchFile(fileId, accessToken);
            if (!file) {
                console.error({
                    message: "Failed to fetch file",
                    error: "File is undefined",
                });
                return null;
            }

            const parsedFile = parseFile(file);
            return createJsonResponse({
                streams: [createStream(parsedFile, accessToken)],
            });
        }

        const metadata = await getMetadata(type, fullId);

        if (!metadata) return createJsonResponse({ streams: [] });

        const parsedStreamRequest = {
            type: type,
            id: fullId,
            season: parseInt(season) || undefined,
            episode: parseInt(episode) || undefined,
            metadata: metadata,
        };

        const streams = await getStreams(parsedStreamRequest);

        if (streams.length === 0) {
            return createJsonResponse({
                streams: [
                    createErrorStream(
                        "No streams found\nTry joining more team drives"
                    ),
                ],
            });
        }
        return createJsonResponse({ streams: streams });
    } catch (error) {
        console.error({
            message: "An unexpected error occurred",
            error: error.toString(),
        });
        return new Response("Internal Server Error", { status: 500 });
    }
}

async function createProxiedStreamResponse(fileId, filename, request) {
    try {
        const accessToken = await getAccessToken();
        const streamUrl = API_ENDPOINTS.DRIVE_STREAM_FILE.replace(
            "{fileId}",
            fileId
        ).replace("{filename}", filename);

        const headers = {
            Authorization: `Bearer ${accessToken}`,
            Range: request.headers.get("Range") || "bytes=0-",
        };

        const response = await fetch(streamUrl, { headers });
        if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.statusText}`);
        }

        return new Response(response.body, {
            headers: {
                "Content-Range": response.headers.get("Content-Range"),
                "Content-Length": response.headers.get("Content-Length"),
            },
            status: response.status,
            statusText: response.statusText,
        });
    } catch (error) {
        console.error({
            message: "Failed to create proxied stream response",
            error: error.toString(),
        });
        return new Response("Internal Server Error", { status: 500 });
    }
}

// Recull tots els títols coneguts d'un IMDB ID (anglès, original, català,
// castellà) per poder casar-los amb noms de carpeta en qualsevol idioma.
async function getTitolsAlternatius(imdbId, type) {
    if (TITLES_CACHE.has(imdbId)) return TITLES_CACHE.get(imdbId);

    const titles = [];
    const afegeix = (t) => {
        if (t && !titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    };

    try {
        const meta = await getCinemetaMeta(type, imdbId);
        afegeix(meta?.name);
    } catch (e) { /* ignore */ }

    if (CONFIG.tmdbApiKey) {
        const findUrl = API_ENDPOINTS.TMDB_FIND
            .replace("{id}", imdbId)
            .replace("{apiKey}", CONFIG.tmdbApiKey);
        for (const lang of ["ca", "es", "en"]) {
            try {
                const res = await fetch(findUrl + `&language=${lang}`);
                if (!res.ok) continue;
                const data = await res.json();
                const r = data.tv_results?.[0] || data.movie_results?.[0];
                if (!r) continue;
                afegeix(r.name || r.title);
                afegeix(r.original_name || r.original_title);
            } catch (e) { /* ignore */ }
        }
    }

    TITLES_CACHE.set(imdbId, titles);
    return titles;
}

function normalitzaTitol(t) {
    return (t || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function findCollectionFolder(imdbId, accessToken) {
    if (IMDB_TO_GDRIVE.has(imdbId)) {
        const mapping = IMDB_TO_GDRIVE.get(imdbId);
        if (mapping.type === "series") return mapping.id;
    }

    const titles = await getTitolsAlternatius(imdbId, "series");
    if (titles.length === 0) return null;
    const titlesNorm = titles.map(normalitzaTitol).filter(Boolean);

    let millor = null; // { id, score }

    for (const rootId of CONFIG.collectionsRootFolderIds) {
        let subfolders;
        try {
            subfolders = await listChildren(rootId, accessToken, { onlyFolders: true });
        } catch (e) { continue; }

        for (const folder of subfolders) {
            const netejat = cleanTitleForSearch(folder.name).queries[0] || folder.name;
            const folderNorm = normalitzaTitol(netejat);
            if (!folderNorm) continue;

            for (const t of titlesNorm) {
                let score = 0;
                if (folderNorm === t) score = 3;
                else if (folderNorm.startsWith(t) || t.startsWith(folderNorm)) score = 2;
                else if (folderNorm.includes(t) || t.includes(folderNorm)) score = 1;
                if (score > 0 && (!millor || score > millor.score)) {
                    millor = { id: folder.id, nom: folder.name, score };
                }
            }
        }
    }

    if (millor) {
        IMDB_TO_GDRIVE.set(imdbId, { type: "series", id: millor.id });
        console.log({ message: "Collection folder trobada", imdbId, carpeta: millor.nom, score: millor.score });
        return millor.id;
    }
    return null;
}

async function findMovieFiles(imdbId, accessToken) {
    const titles = await getTitolsAlternatius(imdbId, "movie");
    if (titles.length === 0) return [];

    const movieFolderIds = CONFIG.moviesFolderIds?.length > 0
        ? CONFIG.moviesFolderIds
        : CONFIG.driveFolderIds;
    if (!movieFolderIds?.length) return [];

    const trobats = new Map(); // fileId → file

    for (const folderId of movieFolderIds) {
        for (const title of titles) {
            const q = `'${folderId}' in parents and trashed=false and mimeType contains 'video/' `
                + `and name contains '${title.replace(/'/g, "\\'")}' `
                + `and not name contains 'trailer' and not name contains 'sample'`;
            const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
            fetchUrl.search = new URLSearchParams({
                q,
                corpora: "allDrives",
                includeItemsFromAllDrives: "true",
                supportsAllDrives: "true",
                pageSize: "50",
                fields: "files(id,name,size,videoMediaMetadata,mimeType,fileExtension)",
            }).toString();
            try {
                const results = await fetchFiles(fetchUrl, accessToken);
                for (const f of results?.files || []) {
                    if (!trobats.has(f.id)) trobats.set(f.id, f);
                }
            } catch (e) { /* ignore */ }
        }
        if (trobats.size > 0) break;
    }

    const files = [...trobats.values()];
    if (files.length > 0) {
        console.log({ message: "Fitxers de pel·lícula trobats", imdbId, count: files.length });
    }
    return files;
}

async function getStreams(streamRequest) {
    const streams = [];
    const imdbId = streamRequest.id.split(":")[0];
    const esImdb = imdbId.startsWith("tt");

    // ── SÈRIES ────────────────────────────────────────────────────────────
    if (esImdb && streamRequest.season && streamRequest.episode) {
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const folderId = await findCollectionFolder(imdbId, accessToken);
                if (folderId) {
                    const targetSeason = parseInt(streamRequest.season, 10);
                    const targetEpisode = parseInt(streamRequest.episode, 10);

                    const [fitxersRuta, structure] = await Promise.all([
                        walkCollectionFiles(folderId, accessToken),
                        getSeasonStructure(imdbId),
                    ]);

                    const { matches, estrategia } = trobaEpisodis(
                        fitxersRuta, targetSeason, targetEpisode, structure
                    );

                    if (matches.length > 0) {
                        // Cada fitxer coincident és una OPCIÓ DE QUALITAT del
                        // mateix episodi, no un episodi diferent.
                        const titolsSerie = await getTitolsAlternatius(imdbId, "series");
                        const titolPerId = new Map();
                        const parsedFiles = matches.map((m) => {
                            const pf = parseFile(m.file);
                            titolPerId.set(pf.id, titolEpisodiDeNom(m.nomArxiu, titolsSerie));
                            return pf;
                        });
                        // Ordena les opcions per resolució/qualitat/idioma
                        sortParsedFiles(parsedFiles);

                        for (const pf of parsedFiles) {
                            const titol = titolPerId.get(pf.id);
                            const stream = createStream(pf, accessToken, {
                                season: targetSeason,
                                episode: targetEpisode,
                                title: titol,
                            });
                            if (stream) streams.push(stream);
                        }
                        console.log({
                            message: "Streams trobats (col·lecció)",
                            imdbId, targetSeason, targetEpisode,
                            estrategia, count: streams.length,
                        });
                        return streams;
                    }
                    console.log({
                        message: "Cap episodi coincident a la col·lecció",
                        imdbId, targetSeason, targetEpisode,
                        fitxersTotals: fitxersRuta.length,
                        teEstructura: !!structure,
                    });
                }
            }
        } catch (e) {
            console.error({ message: "Error cercant streams de sèrie", error: e.toString() });
        }
    }

    // ── PEL·LÍCULES ───────────────────────────────────────────────────────
    if (esImdb && !streamRequest.season && !streamRequest.episode) {
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const files = await findMovieFiles(imdbId, accessToken);
                if (files.length > 0) {
                    const parsedFiles = files.map(parseFile);
                    sortParsedFiles(parsedFiles);
                    for (const pf of parsedFiles) {
                        const stream = createStream(pf, accessToken);
                        if (stream) streams.push(stream);
                    }
                    console.log({ message: "Streams trobats (pel·lícula)", imdbId, count: streams.length });
                    return streams;
                }
            }
        } catch (e) {
            console.error({ message: "Error cercant streams de pel·lícula", error: e.toString() });
        }
    }

    // Fallback: cerca per títol a Google Drive (comportament original)
    const query = await buildSearchQuery(streamRequest);
    console.log({ message: "Built search query (fallback)", query, config: CONFIG });

    const queryParams = {
        q: query,
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        pageSize: "1000",
        fields: "files(id,name,size,videoMediaMetadata,mimeType,fileExtension)",
    };

    const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
    fetchUrl.search = new URLSearchParams(queryParams).toString();

    const accessToken = await getAccessToken();

    if (!accessToken) {
        return [
            createErrorStream(
                "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions"
            ),
        ];
    }

    const results = await fetchFiles(fetchUrl, accessToken);

    if (results?.incompleteSearch) {
        console.warn({ message: "The search was incomplete", results });
    }

    if (!results?.files || results.files.length === 0) {
        console.log({ message: "No files found" });
        return streams;
    }

    console.log({
        message: "Fetched files from Google Drive",
        files: results.files,
    });

    const nameRegex = new RegExp(
        "(?<![^ [(_\\-.])(" +
            streamRequest.metadata.name
                .replace(/[^\w\s]/g, "[^\\w\\s]?")
                .replace(/ /g, "[ .\\-_]?") +
            (streamRequest.type === "movie"
                ? `[ .\\-_]?${streamRequest.metadata.year}`
                : "") +
            ")(?=[ \\)\\]_.-]|$)",
        "i"
    );
    console.log({ message: "Name regex", nameRegex });
    const parsedFiles = parseAndFilterFiles(
        CONFIG.strictTitleCheck
            ? results.files.filter((file) => nameRegex.test(file.name))
            : results.files
    );

    console.log(
        results.files.length - parsedFiles.length === 0
            ? {
                  message: `${parsedFiles.length} files successfully parsed`,
                  files: parsedFiles,
              }
            : {
                  message: `${
                      results.files.length - parsedFiles.length
                  } files were filtered out after parsing`,
                  filesFiltered: results.files.filter(
                      (file) =>
                          !parsedFiles.some(
                              (parsedFile) => parsedFile.id === file.id
                          )
                  ),
                  config: CONFIG,
              }
    );

    sortParsedFiles(parsedFiles);

    console.log({
        message: "All files parsed, filtered, and sorted successfully",
        files: parsedFiles,
    });

    parsedFiles.forEach((parsedFile) => {
        streams.push(createStream(parsedFile, accessToken));
    });

    return streams;
}

export default {
    async fetch(request, env, ctx) {
        CREDENTIALS.clientId = CREDENTIALS.clientId || env.CLIENT_ID;
        CREDENTIALS.clientSecret =
            CREDENTIALS.clientSecret || env.CLIENT_SECRET;
        CREDENTIALS.refreshToken =
            CREDENTIALS.refreshToken || env.REFRESH_TOKEN;
        CONFIG.tmdbApiKey = CONFIG.tmdbApiKey || env.TMDB_API_KEY;

        // Cada invocació parteix del pressupost de subpeticions del pla
        // gratuït (50). En deixem 4 de marge per als imprevistos.
        reiniciaPressupost(46);
        MAPA = null;
        MAPA_BRUT = false;
        globalThis.__ctx = ctx;

        return handleRequest(request);
    },
};
