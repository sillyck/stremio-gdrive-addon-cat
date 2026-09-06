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
    // Cada títol pot costar fins a 6 subpeticions (TMDB x3 + Viquipèdia x2).
    // Amb un pressupost de 46 en caben ~7 per invocació.
    maxResolucionsPerPeticio: 7,

    // Memòria cau del recorregut de col·leccions. Desactivada mentre
    // comprovem els filtres d'extres: així cada petició recorre el Drive de
    // nou i el que veus a Stremio reflecteix sempre l'últim codi desplegat.
    // Per tornar-la a activar, posa-hi true. Amb ella activada, una
    // col·lecció gran com El Detectiu Conan no esgota el pressupost de
    // subpeticions; sense ella, pot tornar a quedar-se a mig recórrer.
    usaCauRecorregut: false,
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

// Identificador de la versió del codi. Serveix per verificar via /versio
// quina versió s'està executant realment al worker.
const VERSIO_CODI = "2026-09-06.sense-cau-recorregut";

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

// Índex invers imdbId → { tipus, id }. Es construeix a partir del mapa
// persistent, que és el que /omplir ha anat omplint. Sense això, una petició
// d'streams que arriba des d'AIOMetadata no té manera de saber quina carpeta
// o fitxer del Drive correspon a aquell IMDb ID, i acaba en "No streams found".
let INDEX_INVERS = null;

function construeixIndexInvers() {
    INDEX_INVERS = new Map();
    if (!MAPA) return INDEX_INVERS;
    for (const [clau, valor] of Object.entries(MAPA)) {
        if (!valor?.imdbId) continue;
        const tipus = clau.startsWith("s:") ? "series" : "movie";
        const id = clau.slice(2);
        const existent = INDEX_INVERS.get(valor.imdbId);
        if (!existent) {
            INDEX_INVERS.set(valor.imdbId, { tipus, ids: [id] });
        } else if (existent.tipus === tipus) {
            // Diverses còpies del mateix títol (qualitats diferents)
            existent.ids.push(id);
        }
    }
    return INDEX_INVERS;
}

async function buscaAlMapa(imdbId) {
    if (!INDEX_INVERS) {
        await carregaMapa();
        construeixIndexInvers();
    }
    return INDEX_INVERS.get(imdbId) || null;
}

// Una entrada sense IMDb ID es reintenta fins a 3 vegades: el reconeixement
// millora amb el temps i no volem que un fracàs antic quedi congelat.
function calReintentar(entrada) {
    if (entrada?.imdbId) return false;
    return (entrada?.intents || 0) < 3;
}

function llegeixMapa(clau) {
    return MAPA?.[clau] || null;
}

function escriuMapa(clau, valor) {
    if (!MAPA) MAPA = {};
    MAPA[clau] = { ...valor, ts: Date.now() };
    MAPA_BRUT = true;
    INDEX_INVERS = null;   // s'ha de reconstruir
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
        .replace(TXC_REGEX, " ")
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

    let senseExt = name.replace(/\.[a-z0-9]{3,4}$/i, "");
    // Molts arxius usen punts (o guions baixos) com a separador:
    // "Robot.Carnival.(K.Otomo,1987).UHDrip.1080p.x264". Si en detectem
    // uns quants, els convertim en espais; si només n'hi ha un o dos els
    // deixem estar, per no trencar títols com "Dr. Slump".
    if ((senseExt.match(/\./g) || []).length >= 3) {
        senseExt = senseExt.replace(/[._]+/g, " ");
    }
    senseExt = senseExt.replace(/_+/g, " ");

    let cleanedName = senseExt
        .replace(/\[.*?\]/g, " ")
        .replace(/\((\d{4})\)/g, " ")
        .replace(/\([^)]*\d{4}[^)]*\)/g, " ")
        .replace(/\([^)]*(?:cat|esp|eng|jap|sub|dub|FLAC|DTS|AVC|BD|HD|by\s)[^)]*\)/gi, " ")
        .replace(/\b\d{3,4}p\b/gi, " ")
        .replace(/\b(?:BDRemux|BDRip|BluRay|WEB-?DL|WEBRip|HDRip|DVDRip|HDTV|CAM|REMUX|UHD(?:rip)?|UHDRemux|4K|DVDScr|TS)\b/gi, " ")
        .replace(/\b(?:x264|x265|h264|h265|HEVC|AVC|AAC|FLAC|DTS|Atmos|AC3|DoVi|HDR\d*)\b/gi, " ")
        .replace(/\b(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL)(?:\s*[-]\s*(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL))*\b/g, " ")
        .replace(/\b(?:cat|esp|eng|jap|val|cas|mal)\b/gi, " ")
        .replace(/\bby\s+\w+/gi, " ")
        .replace(/\bv\d+\b/gi, " ")
        .replace(/\bREEL\d+\b/gi, " ")
        .replace(/\b\d+th\s+Anniversary\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    // L'any pot venir sol "(1987)" o barrejat "(K.Otomo,1987)" / "(1992 480p)"
    const yearMatch = name.match(/\((\d{4})\)/)
        || name.match(/\([^)]*?((?:19|20)\d{2})[^)]*?\)/)
        || name.match(/(?:^|[^\d])((?:19|20)\d{2})(?![\d])/);
    const year = yearMatch ? yearMatch[1] : null;

    // ── Generació de candidats ────────────────────────────────────────────
    // Els noms reals porten marques de capítol o de format enmig del títol
    // ("Regnat de Sang -01- Hikatxi", "Macross Plus OVA 1", "Bola de Drac M07").
    // Cada marca d'aquestes talla el títol real: el que ve després és el nom
    // de l'episodi, no part del títol de l'obra. Generem candidats de més
    // específic a més curt i deixem que la puntuació triï.
    const candidats = [];
    const afegeix = (t) => {
        const net = (t || "").replace(/[\s\-–_:.]+$/,"").replace(/^[\s\-–_:.]+/,"").trim();
        if (net.length > 1 && !candidats.includes(net)) candidats.push(net);
    };

    // Talla a la primera marca de capítol/OVA/pel·lícula numerada
    const TALLS = [
        /\s[-–]\s*\d{1,3}\s*[-–]\s/,                          // "Títol -01- Subtítol"
        /\s\b(?:OVA|OAV|ONA|Especial|Special|Movie|Film|Pel[·.]?l[íi]cula)\b\s*\d*/i,
        /\s\bM\d{1,2}\b/,                                      // "Bola de Drac M07"
        /\s\b(?:Temporada|Season|Saga|Part|Parte)\b\s*\d+/i,
        /\s[-–]\s/,                                             // primer guió solt
    ];
    for (const tall of TALLS) {
        const m = tall.exec(cleanedName);
        if (m && m.index > 2) { afegeix(cleanedName.slice(0, m.index)); break; }
    }

    if (originalTitle) afegeix(originalTitle);
    afegeix(cleanedName);

    // Candidat curt: les 3 primeres paraules. Rescata títols llargs amb
    // subtítol enganxat sense cap separador reconegut.
    const paraules = cleanedName.split(/\s+/);
    if (paraules.length > 3) afegeix(paraules.slice(0, 3).join(" "));

    return { queries: candidats, year };
}

// ── Resolució de títols en català ─────────────────────────────────────────
// TMDB cerca pel títol original, les traduccions i els títols alternatius,
// però les traduccions CATALANES sovint no hi són. Quan TMDB falla anem a la
// Viquipèdia: els seus articles enllacen a Wikidata, que guarda l'ID d'IMDb a
// la propietat P345. Provem primer en català i després en castellà, perquè
// molts títols d'aquest fons hi surten com "Los Bobobobs" o "El mundo de
// Rumiko" encara que el fitxer estigui en català.
async function imdbDesDeViquipedia(titol, any, wiki = "ca") {
    if (!quedaPressupost(4)) return null;
    try {
        const cerca = any ? `${titol} ${any}` : titol;
        const params = new URLSearchParams({
            action: "query",
            format: "json",
            formatversion: "2",
            generator: "search",
            gsrsearch: cerca,
            gsrlimit: "3",
            gsrnamespace: "0",
            prop: "pageprops",
            ppprop: "wikibase_item",
        });

        if (!consumeix(1)) return null;
        const res = await fetch(`https://${wiki}.wikipedia.org/w/api.php?${params}`, {
            headers: { "User-Agent": "stremio-gdrive-addon-cat/1.0" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const pagines = data?.query?.pages || [];

        const qids = pagines
            .map((pg) => pg?.pageprops?.wikibase_item)
            .filter(Boolean)
            .slice(0, 3);
        if (qids.length === 0) return null;

        // Una sola crida a Wikidata per a tots els candidats
        if (!consumeix(1)) return null;
        const wdParams = new URLSearchParams({
            action: "wbgetentities",
            ids: qids.join("|"),
            props: "claims|labels",
            languages: "en|ca|es",
            format: "json",
        });
        const wdRes = await fetch(`https://www.wikidata.org/w/api.php?${wdParams}`, {
            headers: { "User-Agent": "stremio-gdrive-addon-cat/1.0" },
        });
        if (!wdRes.ok) return null;
        const wdData = await wdRes.json();

        for (const qid of qids) {
            const ent = wdData?.entities?.[qid];
            const imdb = ent?.claims?.P345?.[0]?.mainsnak?.datavalue?.value;
            if (typeof imdb === "string" && /^tt\d+$/.test(imdb)) {
                const label = ent?.labels?.en?.value || ent?.labels?.ca?.value
                    || ent?.labels?.es?.value || null;
                console.log({ message: "IMDb via Viquipèdia", wiki, titol, imdb, label });
                return { imdbId: imdb, title: label };
            }
        }
        return null;
    } catch (e) {
        console.error({ message: "Viquipèdia ha fallat", wiki, titol, error: e.toString() });
        return null;
    }
}

// Treu accents i diacrítics: "Anastàsia" → "Anastasia", que sovint ja casa
// directament amb el títol anglès o castellà que TMDB sí que té indexat.
function senseAccents(t) {
    return (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Donat un ID d'IMDb, demana la caràtula i el fons a TMDB. És una cerca per
// identificador, no per text, així que sempre encerta si TMDB coneix l'obra.
// URL de la caràtula generada pel propi worker, per garantir que cap entrada
// del catàleg es quedi sense imatge.
// ── PNG mínim generat a mà ────────────────────────────────────────────────
// Escrivim un PNG vàlid sense cap llibreria: capçalera, IHDR, IDAT amb blocs
// deflate "stored" (sense compressió, que és legal i molt simple) i IEND.
const CRC_TAULA = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TAULA[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function u32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function troç(tipus, dades) {
    const nom = new TextEncoder().encode(tipus);
    const cos = new Uint8Array(nom.length + dades.length);
    cos.set(nom, 0);
    cos.set(dades, nom.length);
    const out = new Uint8Array(4 + cos.length + 4);
    out.set(u32(dades.length), 0);
    out.set(cos, 4);
    out.set(u32(crc32(cos)), 4 + cos.length);
    return out;
}

function hslARgb(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}

// Font de 5x7 píxels: cada glif són 5 columnes i cada columna 7 bits
// (bit 0 = fila superior). Permet imprimir el títol dins la caràtula sense
// cap dependència ni font externa.
const FONT_5X7 = {
    "A":[0x7C,0x12,0x11,0x12,0x7C],"B":[0x7F,0x49,0x49,0x49,0x36],
    "C":[0x3E,0x41,0x41,0x41,0x22],"D":[0x7F,0x41,0x41,0x22,0x1C],
    "E":[0x7F,0x49,0x49,0x49,0x41],"F":[0x7F,0x09,0x09,0x09,0x01],
    "G":[0x3E,0x41,0x49,0x49,0x7A],"H":[0x7F,0x08,0x08,0x08,0x7F],
    "I":[0x00,0x41,0x7F,0x41,0x00],"J":[0x20,0x40,0x41,0x3F,0x01],
    "K":[0x7F,0x08,0x14,0x22,0x41],"L":[0x7F,0x40,0x40,0x40,0x40],
    "M":[0x7F,0x02,0x0C,0x02,0x7F],"N":[0x7F,0x04,0x08,0x10,0x7F],
    "O":[0x3E,0x41,0x41,0x41,0x3E],"P":[0x7F,0x09,0x09,0x09,0x06],
    "Q":[0x3E,0x41,0x51,0x21,0x5E],"R":[0x7F,0x09,0x19,0x29,0x46],
    "S":[0x46,0x49,0x49,0x49,0x31],"T":[0x01,0x01,0x7F,0x01,0x01],
    "U":[0x3F,0x40,0x40,0x40,0x3F],"V":[0x1F,0x20,0x40,0x20,0x1F],
    "W":[0x7F,0x20,0x18,0x20,0x7F],"X":[0x63,0x14,0x08,0x14,0x63],
    "Y":[0x03,0x04,0x78,0x04,0x03],"Z":[0x61,0x51,0x49,0x45,0x43],
    "0":[0x3E,0x51,0x49,0x45,0x3E],"1":[0x00,0x42,0x7F,0x40,0x00],
    "2":[0x42,0x61,0x51,0x49,0x46],"3":[0x21,0x41,0x45,0x4B,0x31],
    "4":[0x18,0x14,0x12,0x7F,0x10],"5":[0x27,0x45,0x45,0x45,0x39],
    "6":[0x3C,0x4A,0x49,0x49,0x30],"7":[0x01,0x71,0x09,0x05,0x03],
    "8":[0x36,0x49,0x49,0x49,0x36],"9":[0x06,0x49,0x49,0x29,0x1E],
    " ":[0,0,0,0,0],"-":[0x08,0x08,0x08,0x08,0x08],
    "'":[0x00,0x05,0x03,0x00,0x00],".":[0x00,0x60,0x60,0x00,0x00],
    "&":[0x36,0x49,0x55,0x22,0x50],":":[0x00,0x36,0x36,0x00,0x00],
    "!":[0x00,0x00,0x5F,0x00,0x00],"?":[0x02,0x01,0x51,0x09,0x06],
};

function aFont(txt) {
    return (txt || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .split("")
        .filter((c) => FONT_5X7[c])
        .join("");
}

// Empaqueta una imatge indexada de 2 bits (4 colors) en un PNG vàlid.
// Amb paleta ocupa 12 vegades menys que en RGB: una caràtula de 240x360
// queda per sota dels 25 kB, molt dins del que recomana Stremio (<100 kB).
function pngIndexat(idx, W, H, paleta) {
    const perFila = Math.ceil(W / 4);           // 4 píxels per byte a 2 bits
    const cru = new Uint8Array(H * (1 + perFila));
    let p = 0;
    for (let y = 0; y < H; y++) {
        cru[p++] = 0;                            // filtre "cap"
        for (let x = 0; x < W; x += 4) {
            let b = 0;
            for (let k = 0; k < 4; k++) {
                const v = x + k < W ? idx[y * W + x + k] & 3 : 0;
                b |= v << (6 - k * 2);
            }
            cru[p++] = b;
        }
    }

    const MAX = 65535;
    const nBlocs = Math.ceil(cru.length / MAX);
    const zlib = new Uint8Array(2 + nBlocs * 5 + cru.length + 4);
    let q = 0;
    zlib[q++] = 0x78; zlib[q++] = 0x01;
    for (let i = 0; i < cru.length; i += MAX) {
        const tros = cru.subarray(i, Math.min(i + MAX, cru.length));
        zlib[q++] = i + MAX >= cru.length ? 1 : 0;
        zlib[q++] = tros.length & 255;
        zlib[q++] = (tros.length >>> 8) & 255;
        zlib[q++] = ~tros.length & 255;
        zlib[q++] = (~tros.length >>> 8) & 255;
        zlib.set(tros, q); q += tros.length;
    }
    zlib.set(u32(adler32(cru)), q); q += 4;

    const ihdr = new Uint8Array(13);
    ihdr.set(u32(W), 0); ihdr.set(u32(H), 4);
    ihdr[8] = 2;    // 2 bits per píxel
    ihdr[9] = 3;    // color indexat (paleta)

    const plte = new Uint8Array(12);
    for (let i = 0; i < 4; i++) {
        plte[i * 3] = paleta[i][0];
        plte[i * 3 + 1] = paleta[i][1];
        plte[i * 3 + 2] = paleta[i][2];
    }

    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        troç("IHDR", ihdr),
        troç("PLTE", plte),
        troç("IDAT", zlib.subarray(0, q)),
        troç("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((n, x) => n + x.length, 0);
    const png = new Uint8Array(total);
    let o = 0;
    for (const x of parts) { png.set(x, o); o += x.length; }
    return png;
}

// Caràtula generada amb el títol imprès. Colors derivats del títol, així que
// cada obra té sempre la mateixa i es distingeixen entre elles d'un cop d'ull.
function pngPortada(titol) {
    const W = 240, H = 360;
    const to = [...(titol || "?")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
    const paleta = [
        hslARgb(to, 38, 16),            // 0 fons
        hslARgb(to, 45, 26),            // 1 banda superior
        hslARgb((to + 25) % 360, 55, 45), // 2 marc
        [245, 245, 245],                 // 3 text
    ];

    const idx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const vora = x < 4 || x >= W - 4 || y < 4 || y >= H - 4;
            idx[y * W + x] = vora ? 2 : (y < H * 0.28 ? 1 : 0);
        }
    }

    const ESCALA = 3;
    const AMPLE_CAR = 6 * ESCALA;
    const MAX_CARS = Math.floor((W - 24) / AMPLE_CAR);

    // Partim per paraules, però una paraula més llarga que la línia s'ha de
    // tallar igualment: si no, es perd pels costats de la caràtula.
    const mots = [];
    for (const mot of aFont(titol).split(" ")) {
        if (!mot) continue;
        if (mot.length <= MAX_CARS) { mots.push(mot); continue; }
        for (let i = 0; i < mot.length; i += MAX_CARS) {
            mots.push(mot.slice(i, i + MAX_CARS));
        }
    }

    const linies = [];
    let actual = "";
    for (const mot of mots) {
        if ((actual + " " + mot).trim().length > MAX_CARS && actual) {
            linies.push(actual.trim());
            actual = mot;
        } else {
            actual = (actual + " " + mot).trim();
        }
    }
    if (actual) linies.push(actual);
    const visibles = linies.slice(0, 9);

    const ALT_LIN = 7 * ESCALA + 10;
    let y0 = Math.round((H - visibles.length * ALT_LIN) / 2);

    for (const lin of visibles) {
        let x0 = Math.round((W - (lin.length * AMPLE_CAR - ESCALA)) / 2);
        for (const ch of lin) {
            const glif = FONT_5X7[ch] || FONT_5X7[" "];
            for (let c = 0; c < 5; c++) {
                for (let f = 0; f < 7; f++) {
                    if (!((glif[c] >> f) & 1)) continue;
                    for (let dy = 0; dy < ESCALA; dy++) {
                        for (let dx = 0; dx < ESCALA; dx++) {
                            const x = x0 + c * ESCALA + dx;
                            const y = y0 + f * ESCALA + dy;
                            if (x >= 0 && x < W && y >= 0 && y < H) idx[y * W + x] = 3;
                        }
                    }
                }
            }
            x0 += AMPLE_CAR;
        }
        y0 += ALT_LIN;
    }

    return pngIndexat(idx, W, H, paleta);
}

function posterGenerat(titol) {
    return `${globalThis.__origin || ""}/poster?t=${encodeURIComponent(titol || "?")}`;
}

async function imatgesPerImdb(imdbId) {
    if (!CONFIG.tmdbApiKey || !imdbId) return null;
    if (!quedaPressupost(2) || !consumeix(1)) return null;
    try {
        const url = API_ENDPOINTS.TMDB_FIND
            .replace("{id}", imdbId)
            .replace("{apiKey}", CONFIG.tmdbApiKey);
        const res = await fetch(url + "&language=ca-ES");
        if (!res.ok) return null;
        const data = await res.json();
        const r = data.movie_results?.[0] || data.tv_results?.[0];
        if (!r) return null;
        return {
            poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
            background: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
            tmdbId: r.id,
            tmdbType: data.movie_results?.length ? "movie" : "tv",
            title: r.title || r.name || null,
        };
    } catch (e) {
        return null;
    }
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

    // Compara sense espais: "Full Metal Alchemist" ↔ "Fullmetal Alchemist"
    const compacta = (t) => normalitza(t).replace(/\s+/g, "");

    // Proporció de paraules compartides. Rescata títols amb l'ordre canviat,
    // articles de més o subtítols afegits.
    function solapament(a, b) {
        const A = new Set(normalitza(a).split(" ").filter((w) => w.length > 2));
        const B = new Set(normalitza(b).split(" ").filter((w) => w.length > 2));
        if (A.size === 0 || B.size === 0) return 0;
        let comuns = 0;
        for (const w of A) if (B.has(w)) comuns++;
        return comuns / Math.min(A.size, B.size);
    }

    function puntua(result, consulta) {
        const cand = [result.name, result.title, result.original_name, result.original_title]
            .filter(Boolean);
        const candN = cand.map(normalitza);
        const q = normalitza(consulta);
        const qC = compacta(consulta);

        if (candN.includes(q)) return 3;
        // Igualtat un cop tretes les separacions de paraules
        if (cand.some((c) => compacta(c) === qC)) return 3;
        if (candN.some((c) => c.startsWith(q) || q.startsWith(c))) return 2;
        if (cand.some((c) => compacta(c).startsWith(qC) || qC.startsWith(compacta(c)))) return 2;
        // Totes les paraules significatives d'un títol són a l'altre
        if (cand.some((c) => solapament(c, consulta) >= 0.99)) return 2;
        if (candN.some((c) => c.includes(q) || q.includes(c))) return 1;
        if (cand.some((c) => solapament(c, consulta) >= 0.6)) return 1;
        return 0;
    }

    try {
        // Només UNA cerca. El paràmetre include_adult=false i language=ca-ES
        // ja retorna els títols catalans/castellans quan existeixen, i TMDB
        // casa prou bé els títols traduïts sense haver de provar idioma per
        // idioma. Això baixa de ~16 subpeticions per títol a 2, que és el que
        // fa que el catàleg càpiga dins dels límits del pla gratuït.
        const endpoint = preferTv ? "tv" : "multi";

        async function cercaTmdb(q) {
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
            if (!res.ok) return null;
            const data = await res.json();
            const results = data.results || [];

            let m = null;
            for (const r of results.slice(0, 8)) {
                const mt = r.media_type || (endpoint === "tv" ? "tv" : "movie");
                if (preferTv && mt === "movie") continue;

                const score = puntua(r, q);
                // PUNTUACIÓ MÍNIMA 2. Amb 1 n'hi havia prou que un títol
                // contingués l'altre o compartissin un 60% de paraules, i
                // això colava obres sense cap relació. Pitjor encara: el
                // match dolent es desava al mapa amb el seu IMDb ID, i això
                // deixava la cerca d'streams apuntant a la carpeta errònia.
                if (score < 2) continue;

                // Desempats, per ordre d'importància:
                let bonus = 0;
                //  · l'any coincideix amb el del nom de la carpeta
                const dataR = r.first_air_date || r.release_date || "";
                if (year && dataR.startsWith(year)) bonus += 0.5;
                else if (year && dataR) {
                    const diff = Math.abs(parseInt(dataR.slice(0, 4), 10) - parseInt(year, 10));
                    if (diff <= 1) bonus += 0.25;
                    else if (diff > 8) bonus -= 0.3;   // molt lluny: sospitós
                }
                //  · animació quan busquem una sèrie. El fons és pràcticament
                //    tot anime i dibuixos, i molts títols tenen una versió
                //    d'imatge real amb el MATEIX nom (ex. Lucky Luke).
                if (preferTv && Array.isArray(r.genre_ids) && r.genre_ids.includes(16)) {
                    bonus += 0.4;
                }

                const total = score + bonus;
                if (!m || total > m.total) m = { result: { ...r, media_type: mt }, score, total };
            }
            return m;
        }

        // NIVELL 1: provar els candidats de títol contra TMDB, de més
        // específic a més curt. Ens aturem en trobar una coincidència exacta.
        let millor = null;
        for (const q of queries) {
            if (!quedaPressupost(5)) break;
            const m = await cercaTmdb(q);
            if (m && (!millor || m.total > millor.total)) millor = m;
            if (millor && millor.score === 3 && millor.total >= 3.4) break;
        }

        // NIVELL 2: sense accents. "Anastàsia" → "Anastasia" casa directament
        // amb el títol que TMDB té indexat en molts casos.
        if ((!millor || millor.score < 3) && quedaPressupost(5)) {
            const sa = senseAccents(queries[0]);
            if (sa !== queries[0]) {
                const alt = await cercaTmdb(sa);
                if (alt && (!millor || alt.total > millor.total)) millor = alt;
            }
        }

        // NIVELL 3: Viquipèdia (catalana i castellana) → Wikidata → IMDb.
        // És l'únic camí fiable per als títols que TMDB no té traduïts.
        if ((!millor || millor.score < 2)) {
            for (const wiki of ["ca", "es"]) {
                if (!quedaPressupost(4)) break;
                const viqui = await imdbDesDeViquipedia(queries[0], year, wiki);
                if (viqui?.imdbId) {
                    // Tenim l'ID d'IMDb però encara no la caràtula: la demanem
                    // a TMDB per ID, que és una cerca exacta i sempre encerta.
                    const art = await imatgesPerImdb(viqui.imdbId);
                    const out = {
                        poster: art?.poster
                            || `https://btttr.cc/poster-n/imdb/poster-default/${viqui.imdbId}.jpg`,
                        background: art?.background || null,
                        imdbId: viqui.imdbId,
                        tmdbId: art?.tmdbId || null,
                        tmdbType: art?.tmdbType || (preferTv ? "tv" : "movie"),
                        title: art?.title || viqui.title,
                        score: 2,
                        font: "viquipedia:" + wiki,
                    };
                    TMDB_CACHE.set(cacheKey, out);
                    return out;
                }
            }
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
            // TMDB serveix les imatges des d'un CDN sense clau ni límits, i la
            // seva cobertura és molt més alta que la de btttr.cc. Per això va
            // primer; btttr.cc queda com a reserva quan TMDB no té caràtula.
            poster: result.poster_path
                ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
                : (imdbId ? `https://btttr.cc/poster-n/imdb/poster-default/${imdbId}.jpg` : null),
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

// Carpetes que dins d'una col·lecció NO contenen episodis de la sèrie:
// extres, bandes sonores, obertures, pel·lícules, OVAs, especials... Cal
// saltar-les per dos motius, tots dos importants:
//   1. CORRECCIÓ. Un tema musical "01 - Opening.mp3" o una OVA numerada 01
//      compta com a episodi 1 i apareix com a opció d'un episodi que no és.
//   2. PRESSUPOST. La carpeta d'El Detectiu Conan té desenes de subcarpetes
//      d'extres, i recórrer-les esgotava el límit de subpeticions abans
//      d'arribar als episodis de veritat.
const CARPETES_NO_EPISODIS = new RegExp(
    "^\\s*(?:" + [
        "extres?", "extras?", "bonus", "especials?", "specials?",
        "m[úu]sica?", "music", "ost", "soundtracks?", "singles?",
        "op(?:s)?(?:[\\s&_-]*ed(?:s)?)?", "ed(?:s)?", "openings?", "endings?",
        "pel[·.]?l[íi]cules?", "pelis?", "movies?", "films?",
        "ova(?:s)?", "oav(?:s)?", "ona(?:s)?",
        "scans?", "artbooks?", "manga", "covers?", "car[àa]tules?",
        "subs?", "subt[íi]tols?", "subtitles?",
        "trailers?", "previews?", "nc(?:op|ed)",
    ].join("|") + ")\\s*$",
    "i"
);

// Fitxers que són dins la carpeta de la sèrie però NO són episodis:
// openings, endings, OVAs, pel·lícules, tràilers. Sense aquest filtre, un
// "OP1.mkv" o un "OVA 01.mkv" es comptava com a episodi 1 i apareixia com a
// opció d'un episodi que no li corresponia.
//
// Regla de seguretat: si el nom porta una marca EXPLÍCITA de temporada i
// episodi (S01E05, T1xC05, 1x05), és un episodi i no s'exclou mai. Això
// evita descartar episodis amb títols com "L'obertura del torneig".
function esFitxerNoEpisodi(nom) {
    const base = nom.replace(/\.[a-z0-9]{2,4}$/i, "").trim();

    if (SXE_REGEX.test(base) || TXC_REGEX.test(base) || NXM_REGEX.test(base)
        || TEMPORADA_EP_REGEX.test(base)) {
        return false;
    }

    const net = base.replace(/\[.*?\]/g, " ").replace(/\s+/g, " ").trim();

    // Noms que consisteixen NOMÉS en la marca: "OP", "NCED2", "ED 03"
    if (/^(?:nc)?(?:op|ed)\s*\d*$/i.test(net)) return true;

    // Comencen per la marca: "OVA 01 - …", "Opening 2", "Pel·lícula 03 - …"
    if (/^(?:ova|oav|ona)\b/i.test(net)) return true;
    if (/^(?:opening|ending|obertura|tancament)\b/i.test(net)) return true;
    if (/^(?:pel[·.]?l[íi]cula|pelicula|movie|film)\b/i.test(net)) return true;
    if (/^(?:trailer|tr[àa]iler|teaser|promo|preview|pv|cm)\b/i.test(net)) return true;
    if (/^(?:nc)?(?:op|ed)\s*\d+\b/i.test(net)) return true;

    // La marca com a paraula solta en qualsevol posició
    if (/\b(?:ncop|nced)\b/i.test(net)) return true;
    if (/\b(?:opening|ending)\s*\d+\b/i.test(net)) return true;
    if (/\bova\s*\d+\b/i.test(net)) return true;

    return false;
}

function esCarpetaDExtres(nom) {
    if (CARPETES_NO_EPISODIS.test(nom)) return true;
    // Comença per la paraula: "Extres i coses", "Music Collection"…
    if (/^\s*(?:extres?|extras?|m[úu]sica?|music|ost|ova|oav|ona|nc)\b[\s&_-]/i.test(nom)) return true;
    // Acaba en OST: "Series OST", "Movies OST"
    if (/\bost\s*$/i.test(nom)) return true;
    return false;
}

// ── Memòria cau del recorregut ────────────────────────────────────────────
// Recórrer una col·lecció gran costa una subpetició per carpeta, i amb el
// límit de 50 del pla gratuït una sèrie amb moltes subcarpetes s'esgotava a
// mig camí (era el cas d'El Detectiu Conan). Desem l'arbre de fitxers ja
// recorregut: la següent petició el llegeix amb UNA sola subpetició i, a
// més, el llistat és complet.
// La clau inclou la versió del codi: així, cada desplegament invalida
// automàticament tots els recorreguts desats. Sense això, un canvi als
// filtres d'extres trigava un dia a notar-se perquè el cau servia l'arbre
// antic, amb els extres inclosos.
function clauCauRecorregut(folderId) {
    const v = VERSIO_CODI.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `https://gdrive-addon.local/__walk/${v}/${folderId}`;
}

async function llegeixRecorregutDelCau(folderId) {
    try {
        if (!CONFIG.usaCauRecorregut) return null;
        if (typeof caches === "undefined" || !consumeix(1)) return null;
        const r = await caches.default.match(new Request(clauCauRecorregut(folderId)));
        if (!r) return null;
        const dades = await r.json();
        console.log({ message: "Recorregut recuperat del cau", folderId, fitxers: dades.length });
        return dades;
    } catch (e) {
        return null;
    }
}

async function desaRecorregutAlCau(folderId, fitxers) {
    try {
        if (!CONFIG.usaCauRecorregut) return;
        if (typeof caches === "undefined") return;
        const r = new Response(JSON.stringify(fitxers), {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "max-age=86400",   // un dia
            },
        });
        const promesa = caches.default.put(new Request(clauCauRecorregut(folderId)), r);
        if (globalThis.__ctx?.waitUntil) globalThis.__ctx.waitUntil(promesa);
        else await promesa;
    } catch (e) { /* el cau és una optimització, no una dependència */ }
}

async function walkCollectionFiles(rootFolderId, accessToken, maxDepth = 6) {
    const delCau = await llegeixRecorregutDelCau(rootFolderId);
    if (delCau) return delCau;

    const resultats = [];
    const saltades = [];
    const fitxersOmesos = [];
    let complet = true;

    async function recorre(folderId, ruta, profunditat) {
        if (profunditat > maxDepth) return;
        if (!quedaPressupost(4)) {
            complet = false;
            console.log({ message: "Pressupost exhaurit recorrent la col·lecció", ruta });
            return;
        }
        const fills = await listChildren(folderId, accessToken);
        for (const item of fills) {
            if (item.mimeType === FOLDER_MIME) {
                if (esCarpetaDExtres(item.name)) {
                    saltades.push([...ruta, item.name].join("/"));
                    continue;
                }
                await recorre(item.id, [...ruta, item.name], profunditat + 1);
            } else if (VIDEO_EXT_REGEX.test(item.name)) {
                if (esFitxerNoEpisodi(item.name)) {
                    fitxersOmesos.push(item.name);
                    continue;
                }
                resultats.push({ file: item, ruta: [...ruta, item.name] });
            }
        }
    }

    await recorre(rootFolderId, [], 0);
    if (saltades.length) {
        console.log({ message: "Carpetes d'extres omeses", saltades: saltades.slice(0, 12) });
    }
    if (fitxersOmesos.length) {
        console.log({ message: "Fitxers que no són episodis, omesos",
                      quants: fitxersOmesos.length, mostra: fitxersOmesos.slice(0, 8) });
    }
    // Només desem el recorregut si ha estat COMPLET. Desar-ne un de truncat
    // congelaria una llista incompleta durant tot un dia.
    if (complet && resultats.length > 0) {
        await desaRecorregutAlCau(rootFolderId, resultats);
        console.log({ message: "Recorregut complet desat al cau", rootFolderId, fitxers: resultats.length });
    } else if (!complet) {
        console.log({ message: "Recorregut incomplet: no es desa al cau", rootFolderId, fitxers: resultats.length });
    }
    return resultats;
}


// El separador pot ser una "x" llatina o el signe de multiplicació "×" (U+00D7),
// que és el que fan servir molts arxius i el que feia fallar el reconeixement.
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

// ═══════════════════════════════════════════════════════════════════════════
// NUMERACIÓ D'EPISODIS
//
// Principi de disseny: MAI analitzar un fitxer aïlladament. Provem cada patró
// contra TOT el conjunt de fitxers de la sèrie i ens quedem amb el que
// realment discrimina. Un patró que assigna el mateix número a tots els
// fitxers ha fallat per definició, i abans això passava desapercebut: era la
// causa que clicar un episodi retornés desenes de fitxers equivocats.
//
// El llistat d'episodis i la cerca d'streams comparteixen aquesta mateixa
// funció. Si divergissin, el fitxer que es llista com a episodi N no seria el
// que es reprodueix en clicar-lo.
// ═══════════════════════════════════════════════════════════════════════════

const SXE_REGEX = /\bs\s*(\d{1,2})\s*[ ._×x-]?\s*e\s*(\d{1,3})\b/i;
const TXC_REGEX = /\bT\s*(\d{1,2})\s*[x×._-]?\s*C\s*(\d{1,3})\b/i;
const TEMPORADA_EP_REGEX = /\b(?:temporada|season|saga|temp)[\s._-]*(\d{1,2})[\s._-]*(?:cap[íi]tol|episodi|episode|ep|cap)[\s._-]*(\d{1,3})\b/i;
const NXM_REGEX = /\b(\d{1,2})\s*[x×]\s*(\d{1,3})\b/i;
const EP_EXPLICIT_REGEX = /\b(?:cap[íi]tol|episodi|episode|ep|cap)[\s._-]*(\d{1,3})\b/i;

// Ordenats de més específic a més genèric. En cas d'empat de puntuació guanya
// el primer, que és el més fiable.
const PATRONS_EPISODI = [
    { nom: "SxE",     re: SXE_REGEX,            gTemp: 1, gEp: 2 },
    { nom: "TxC",     re: TXC_REGEX,            gTemp: 1, gEp: 2 },
    { nom: "TempEp",  re: TEMPORADA_EP_REGEX,   gTemp: 1, gEp: 2 },
    { nom: "NxM",     re: NXM_REGEX,            gTemp: 1, gEp: 2 },
    { nom: "EpMot",   re: EP_EXPLICIT_REGEX,    gTemp: 0, gEp: 1 },
    { nom: "EpFinal", re: /[\s._-](\d{1,3})\s*$/, gTemp: 0, gEp: 1 },
    { nom: "NumSep",  re: /(?:^|[\s._-])(\d{1,3})(?=[\s._-]|$)/, gTemp: 0, gEp: 1 },
    { nom: "NumQual", re: /(\d{1,4})(?!\d)/,    gTemp: 0, gEp: 1 },
];

const ESQUEMES_AMB_TEMPORADA = ["SxE", "TxC", "TempEp", "NxM"];

// Elimina del nom els trossos numèrics que NO són números d'episodi
// (resolucions, anys, còdecs, mides, versions), perquè no contaminin la cerca.
function netejaSorollNumeric(nom) {
    return nom
        .replace(/\.[a-z0-9]{2,4}$/i, " ")
        .replace(/\[.*?\]/g, " ")
        .replace(/\b\d{3,4}p\b/gi, " ")
        .replace(/\b(?:19|20)\d{2}\b/g, " ")
        .replace(/\bx?26[45]\b/gi, " ")
        .replace(/\bh\.?26[45]\b/gi, " ")
        .replace(/\bv\d+\b/gi, " ")
        .replace(/\b\d+(?:\.\d+)?\s*(?:GB|MB|kbps|fps|bits?)\b/gi, " ")
        .replace(/\b(?:AC3|DTS|AAC|FLAC|DD[P+]?)\s*\d?(?:\.\d)?\b/gi, " ")
        .replace(/\b\d+\s*ch\b/gi, " ")
        .replace(/\b4K\b/gi, " ")
        .replace(/\bby\s+\w+/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Temporada indicada per alguna carpeta de la ruta ("Temporada 2", "T3", "02")
function temporadaDeCarpeta(ruta) {
    for (let i = ruta.length - 2; i >= 0; i--) {
        const c = ruta[i];
        let m = /\b(?:temporada|season|saga|temp)[\s._-]*(\d{1,2})\b/i.exec(c);
        if (m) return parseInt(m[1], 10);
        m = /^\s*[TS]\s*(\d{1,2})\s*$/i.exec(c);
        if (m) return parseInt(m[1], 10);
        m = /^\s*(\d{1,2})\s*$/.exec(c);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}

// Mesura com de bé un patró separa els fitxers entre ells
function avaluaPatro(patro, items) {
    const assignacions = [];
    let encerts = 0;
    for (const it of items) {
        const m = patro.re.exec(it.net);
        if (!m) { assignacions.push(null); continue; }
        const ep = parseInt(m[patro.gEp], 10);
        if (!Number.isFinite(ep)) { assignacions.push(null); continue; }
        const temp = patro.gTemp ? parseInt(m[patro.gTemp], 10) : null;
        assignacions.push({ season: temp, episode: ep });
        encerts++;
    }
    if (encerts === 0) return { patro, puntuacio: 0, assignacions, encerts, distints: 0 };

    const claus = new Set(
        assignacions.filter(Boolean).map((a) => `${a.season ?? "-"}:${a.episode}`)
    );

    // Guarda de seguretat: si un patró assigna el MATEIX valor a més de dos
    // fitxers, no està reconeixent res — el descartem del tot.
    if (claus.size === 1 && encerts > 2) {
        return { patro, puntuacio: 0, assignacions, encerts, distints: 1, motiu: "col·lapsa" };
    }

    return {
        patro,
        puntuacio: (encerts / items.length) * (claus.size / encerts),
        assignacions, encerts, distints: claus.size,
    };
}

function detectaEsquema(fitxersRuta) {
    const items = fitxersRuta.map((f) => {
        const nomArxiu = f.ruta[f.ruta.length - 1];
        return {
            file: f.file,
            ruta: f.ruta,
            nomArxiu,
            net: netejaSorollNumeric(nomArxiu),
            seasonCarpeta: temporadaDeCarpeta(f.ruta),
        };
    });

    let millor = null;
    for (const p of PATRONS_EPISODI) {
        const r = avaluaPatro(p, items);
        if (!millor || r.puntuacio > millor.puntuacio + 1e-9) millor = r;
    }

    // Cap patró és prou fiable: caiem a l'ordre alfanumèric amb què Drive ens
    // ha retornat els fitxers. No és perfecte, però dona episodis DIFERENTS
    // per a peticions diferents, que és el mínim exigible.
    if (!millor || millor.puntuacio < 0.3) {
        items.forEach((it, i) => {
            it.season = it.seasonCarpeta ?? 1;
            it.episode = i + 1;
            it.font = "posicional";
        });
        return { items, esquema: "posicional" };
    }

    items.forEach((it, i) => {
        const a = millor.assignacions[i];
        it.episode = a ? a.episode : null;
        it.season = a?.season ?? it.seasonCarpeta ?? null;
        it.font = millor.patro.nom;
    });
    return { items, esquema: millor.patro.nom };
}

// Converteix temporada/episodi a número absolut segons l'estructura de TMDB.
// Ex.: amb T1 de 26 episodis, S02E05 és l'absolut 31.
function aAbsolut(season, episode, estructura) {
    if (!estructura) return null;
    let total = 0;
    for (let s = 1; s < season; s++) {
        if (estructura[s] == null) return null;
        total += estructura[s];
    }
    return total + episode;
}

// Cerca els fitxers de l'episodi demanat.
// GARANTIA: cap fitxer retornat té un número d'episodi diferent del demanat.
function trobaEpisodis(fitxersRuta, targetSeason, targetEpisode, estructura) {
    const { items, esquema } = detectaEsquema(fitxersRuta);

    // 1. L'esquema ja porta temporada al nom: coincidència exacta
    if (ESQUEMES_AMB_TEMPORADA.includes(esquema)) {
        const m = items.filter(
            (i) => i.season === targetSeason && i.episode === targetEpisode
        );
        return { matches: m, estrategia: esquema, esquema };
    }

    // 2. La temporada ve de la carpeta contenidora
    if (items.some((i) => i.seasonCarpeta != null)) {
        const m = items.filter(
            (i) => i.seasonCarpeta === targetSeason && i.episode === targetEpisode
        );
        if (m.length) return { matches: m, estrategia: "carpeta+ep", esquema };
    }

    // 3. Numeració plana. Si el número més alt supera els episodis de la
    //    primera temporada, la numeració és absoluta i cal convertir-hi
    //    la petició (cas típic dels animes llargs).
    const maxEp = Math.max(0, ...items.map((i) => i.episode || 0));
    const epsT1 = estructura?.[1] ?? null;
    const absolut = aAbsolut(targetSeason, targetEpisode, estructura);

    if (epsT1 != null && maxEp > epsT1 && absolut != null) {
        const m = items.filter((i) => i.episode === absolut);
        if (m.length) return { matches: m, estrategia: "absolut", esquema };
    }

    if (targetSeason === 1 || !estructura) {
        const m = items.filter((i) => i.episode === targetEpisode);
        if (m.length) return { matches: m, estrategia: "pla", esquema };
    }

    if (absolut != null) {
        const m = items.filter((i) => i.episode === absolut);
        if (m.length) return { matches: m, estrategia: "absolut-2", esquema };
    }

    return { matches: [], estrategia: "cap", esquema };
}

// Llistat d'episodis per al catàleg propi. Fa servir EXACTAMENT la mateixa
// detecció que la cerca d'streams: si divergissin, el fitxer llistat com a
// episodi N no seria el que es reprodueix en clicar-lo.
function assignaEpisodis(fitxersRuta) {
    const { items, esquema } = detectaEsquema(fitxersRuta);
    const ambTemporada = ESQUEMES_AMB_TEMPORADA.includes(esquema);

    const episodis = items.map((it) => ({
        file: it.file,
        season: ambTemporada
            ? (it.season != null ? it.season : 1)
            : (it.seasonCarpeta ?? 1),
        episode: it.episode,
        title: it.nomArxiu,
    }));

    // Els que no han rebut número van al final, sense col·lisionar
    let seguent = Math.max(0, ...episodis.map((e) => e.episode || 0)) + 1;
    for (const e of episodis) if (e.episode == null) e.episode = seguent++;

    episodis.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return episodis;
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
    // Sense metadata externa no es pot construir la cerca per títol. No és un
    // error: vol dir que aquest camí de reserva no és aplicable i que ja
    // s'han provat abans les vies fiables (mapa i coincidència de carpeta).
    if (!streamRequest.metadata?.name) return null;
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
        globalThis.__origin = url.origin;

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

        // Diu quina versió del codi s'està executant realment. Serveix per
        // saber d'un cop d'ull si un desplegament ha arribat de debò o si
        // encara s'executa una versió antiga.
        if (url.pathname === "/versio") {
            const mapa = await carregaMapa();
            const total = Object.keys(mapa || {}).length;
            const ambImdb = Object.values(mapa || {}).filter((v) => v?.imdbId).length;
            return createJsonResponse({
                versio: VERSIO_CODI,
                funcionsPresents: {
                    deteccioEsquemaEpisodis: typeof detectaEsquema === "function",
                    llistatICercaUnificats:
                        typeof assignaEpisodis === "function" && typeof trobaEpisodis === "function",
                    indexInversDelMapa: typeof buscaAlMapa === "function",
                    caratulaGenerada: typeof pngPortada === "function",
                    resolucioViquipedia: typeof imdbDesDeViquipedia === "function",
                    reintentTitolsFallits: typeof calReintentar === "function",
                },
                mapa: { entrades: total, ambImdbId: ambImdb, sensResoldre: total - ambImdb },
                cauRecorregut: CONFIG.usaCauRecorregut ? "actiu" : "desactivat (proves)",
            });
        }

        if (url.pathname === "/")
            return Response.redirect(url.origin + "/manifest.json", 301);

        // Escalfa el mapa: resol tants títols com permeti el pressupost i et
        // diu quants en queden. Cridant-lo unes quantes vegades el catàleg
        // queda complet i, a partir d'aquí, carrega a l'instant.
        // Caràtula generada al vol. És l'última xarxa de seguretat: quan no
        // hi ha imatge ni a TMDB ni a btttr.cc, val més una portada amb el
        // títol que no pas el requadre buit. No costa cap subpetició.
        // Caràtula generada al vol, en PNG. L'especificació de Stremio demana
        // PNG: un SVG no es renderitza i queda el requadre buit. Aquí generem
        // un PNG mínim (degradat vertical de color estable segons el títol)
        // sense cap dependència externa ni cap subpetició.
        if (url.pathname === "/poster") {
            const titol = url.searchParams.get("t") || "?";
            // NOTA: abans això intentava servir la miniatura que Drive genera
            // del vídeo. Es va descartar perquè la miniatura és sempre el
            // primer fotograma —pantalla negra, crèdits o un pla sense
            // context— i produïa portades pitjors que no tenir-ne cap.
            // Ara sempre generem una fitxa amb el títol, que almenys és
            // llegible i identifica l'obra.

            return new Response(pngPortada(titol), {
                headers: {
                    "Content-Type": "image/png",
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                },
            });
        }

        if (url.pathname === "/omplir") {
            const accessToken = await getAccessToken();
            if (!accessToken) return createJsonResponse({ error: "Credencials invàlides" }, 500);
            await carregaMapa();

            let resoltes = 0, totalSeries = 0, totalPelis = 0, pendents = 0;

            // ── Sèries ────────────────────────────────────────────────────
            for (const rootId of CONFIG.collectionsRootFolderIds) {
                let carpetes = [];
                try { carpetes = await listChildren(rootId, accessToken, { onlyFolders: true }); }
                catch (e) { continue; }
                totalSeries += carpetes.length;
                for (const folder of carpetes) {
                    const previ = llegeixMapa("s:" + folder.id);
                    // Un intent fallit NO és definitiu: la lògica de
                    // reconeixement va millorant, així que els reintentem
                    // unes quantes vegades abans de donar-los per perduts.
                    if (previ && !calReintentar(previ)) continue;
                    if (!quedaPressupost(8)) { pendents++; continue; }
                    const r = await getTmdbPosterByName(folder.name, { preferTv: true });
                    escriuMapa("s:" + folder.id, r?.imdbId
                        ? { imdbId: r.imdbId, poster: r.poster, background: r.background, title: r.title }
                        : { imdbId: null, poster: r?.poster || null, background: r?.background || null,
                            title: r?.title || null, intents: (previ?.intents || 0) + 1 });
                    resoltes++;
                }
            }

            // ── Pel·lícules ───────────────────────────────────────────────
            const carpetesPelis = CONFIG.moviesFolderIds?.length
                ? CONFIG.moviesFolderIds : CONFIG.driveFolderIds;
            for (const folderId of carpetesPelis || []) {
                if (!quedaPressupost(8)) break;
                let fitxers = [];
                try {
                    fitxers = await listChildren(folderId, accessToken, { onlyFiles: true });
                } catch (e) { continue; }
                const videos = fitxers.filter((f) => VIDEO_EXT_REGEX.test(f.name));
                totalPelis += videos.length;
                for (const file of videos) {
                    const previ = llegeixMapa("m:" + file.id);
                    if (previ && !calReintentar(previ)) continue;
                    if (!quedaPressupost(8)) { pendents++; continue; }
                    const r = await getTmdbPosterByName(file.name);
                    escriuMapa("m:" + file.id, r?.imdbId
                        ? { imdbId: r.imdbId, poster: r.poster, background: r.background, title: r.title }
                        : { imdbId: null, poster: r?.poster || null, background: r?.background || null,
                            title: r?.title || null, intents: (previ?.intents || 0) + 1 });
                    resoltes++;
                }
            }

            await desaMapa(null);

            const alMapa = Object.keys(MAPA || {}).length;
            const total = totalSeries + totalPelis;
            const restants = Math.max(0, total - alMapa);
            const acabat = restants === 0 && pendents === 0;

            // Des del navegador retornem una pàgina que es refresca sola: així
            // n'hi ha prou d'obrir-la una vegada i deixar-la treballar, en
            // comptes d'haver de recarregar a mà desenes de vegades.
            const acceptaHtml = (request.headers.get("Accept") || "").includes("text/html");
            if (acceptaHtml) {
                const pct = total > 0 ? Math.round((alMapa / total) * 100) : 100;
                const html = `<!DOCTYPE html><html lang="ca"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${acabat ? "" : '<meta http-equiv="refresh" content="2">'}
<title>Omplint el catàleg</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;
      margin:0;padding:2rem;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .c{max-width:32rem;width:100%}
 h1{font-size:1.25rem;margin:0 0 1.5rem}
 .bar{background:#333;border-radius:99px;height:1.5rem;overflow:hidden;margin:1rem 0}
 .fill{background:${acabat ? "#4ade80" : "#60a5fa"};height:100%;width:${pct}%;transition:width .4s}
 table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:.9rem}
 td{padding:.4rem 0;border-bottom:1px solid #262626}
 td:last-child{text-align:right;color:#a3a3a3}
 .ok{color:#4ade80;font-weight:600}
</style></head><body><div class="c">
<h1>${acabat ? '<span class="ok">Catàleg complet</span>' : "Resolent metadades…"}</h1>
<div class="bar"><div class="fill"></div></div>
<table>
 <tr><td>Progrés</td><td>${alMapa} / ${total} (${pct}%)</td></tr>
 <tr><td>Sèries</td><td>${totalSeries}</td></tr>
 <tr><td>Pel·lícules</td><td>${totalPelis}</td></tr>
 <tr><td>Resoltes en aquesta passada</td><td>${resoltes}</td></tr>
 <tr><td>Pressupost restant</td><td>${PRESSUPOST}</td></tr>
</table>
<p style="color:#a3a3a3;font-size:.85rem;margin-top:1.5rem">
${acabat
  ? "Ja pots tancar aquesta pàgina i obrir Stremio."
  : "Deixa la pàgina oberta: es refresca sola cada 2 segons fins acabar."}
</p></div></body></html>`;
                return new Response(html, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
                });
            }

            return createJsonResponse({
                acabat,
                totalSeries,
                totalPelis,
                entradesAlMapa: alMapa,
                resoltesAquestaVegada: resoltes,
                pressupostRestant: PRESSUPOST,
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
                poster: dades?.poster || posterGenerat(dades?.title || name),
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
                            poster: dades.poster || posterGenerat(dades.title || folder.name),
                            background: dades.background || null,
                        });
                    } else {
                        metas.push({
                            id: `gdriveshow:${folder.id}`,
                            type: "series",
                            name: folder.name,
                            posterShape: "poster",
                            poster: dades.poster || posterGenerat(folder.name),
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
                        poster: posterGenerat(folder.name),
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

        // Que Cinemeta/TMDB/IMDb no responguin NO vol dir que no puguem
        // servir res: si el mapa ja associa aquest IMDb ID amb un fitxer del
        // Drive, la metadata externa és prescindible. Abans es retornava una
        // llista buida i el títol quedava sense cap opció de reproducció.
        if (!metadata) {
            console.log({ message: "Sense metadata externa; provo pel mapa", fullId });
        }

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
        if (mapping.type === "series") return [mapping.id];
    }

    // El mapa persistent ja té la correspondència si /omplir l'ha resolt.
    // Pot haver-hi MÉS D'UNA carpeta amb el mateix IMDb ID (per exemple una
    // per qualitat o per temporada), així que les retornem totes i qui crida
    // les prova una a una fins que alguna contingui l'episodi demanat.
    const delMapa = await buscaAlMapa(imdbId);
    if (delMapa?.tipus === "series" && delMapa.ids.length) {
        console.log({ message: "Carpetes trobades al mapa", imdbId, carpetes: delMapa.ids });
        return delMapa.ids;
    }

    const titles = await getTitolsAlternatius(imdbId, "series");
    if (titles.length === 0) return null;
    const titlesNorm = titles.map(normalitzaTitol).filter(Boolean);

    const candidats = new Map(); // folderId → { id, nom, score }

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
                if (score > 0) {
                    const previ = candidats.get(folder.id);
                    if (!previ || score > previ.score) {
                        candidats.set(folder.id, { id: folder.id, nom: folder.name, score });
                    }
                }
            }
        }
    }

    const llista = [...candidats.values()];
    if (llista.length === 0) return [];

    // Una coincidència EXACTA mana sobre qualsevol parcial. És el que
    // distingeix "Inazuma Eleven" de "Inazuma Eleven GO": amb coincidència
    // per prefix, cada títol encaixava amb la carpeta de l'altre i guanyava
    // la primera que es trobés, de manera que les dues sèries donaven els
    // mateixos episodis.
    const exactes = llista.filter((c) => c.score === 3);
    if (exactes.length) {
        IMDB_TO_GDRIVE.set(imdbId, { type: "series", id: exactes[0].id });
        console.log({ message: "Carpeta trobada (exacta)", imdbId, carpeta: exactes[0].nom });
        return exactes.map((c) => c.id);
    }

    // Sense coincidència exacta, només acceptem una coincidència parcial si
    // NO és ambigua. Amb diverses candidates val més no retornar res que
    // servir els episodis d'una altra sèrie.
    const millorPunt = Math.max(...llista.map((c) => c.score));
    const millors = llista.filter((c) => c.score === millorPunt);
    if (millors.length === 1) {
        IMDB_TO_GDRIVE.set(imdbId, { type: "series", id: millors[0].id });
        console.log({ message: "Carpeta trobada (parcial)", imdbId, carpeta: millors[0].nom, score: millorPunt });
        return [millors[0].id];
    }

    console.log({
        message: "Coincidència ambigua: no s'assigna cap carpeta",
        imdbId,
        candidates: millors.map((c) => c.nom).slice(0, 5),
    });
    return [];
}

async function findMovieFiles(imdbId, accessToken) {
    // 1r: el mapa persistent. Cada entrada "m:<fileId>" resolta per /omplir
    // ja porta el seu imdbId, així que aquí no cal ni cercar ni endevinar.
    const delMapa = await buscaAlMapa(imdbId);
    if (delMapa?.tipus === "movie" && delMapa.ids.length) {
        const fitxers = [];
        for (const fileId of delMapa.ids.slice(0, 8)) {
            if (!quedaPressupost(4)) break;
            try {
                const f = await fetchFile(fileId, accessToken);
                if (f) fitxers.push(f);
            } catch (e) { /* el fitxer pot haver desaparegut */ }
        }
        if (fitxers.length) {
            console.log({ message: "Fitxers trobats al mapa", imdbId, count: fitxers.length });
            return fitxers;
        }
    }

    // 2n: cerca per títol al Drive (per a fitxers encara no resolts)
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

    // ── ID intern: apunta a un fitxer concret del Drive ───────────────────
    // El nostre propi catàleg (i el llistat d'episodis de les col·leccions)
    // fa servir "gdrive:<fileId>". Aquí no cal cercar ni endevinar res: el
    // fitxer ja està identificat. Sense aquest camí, clicar un episodi del
    // catàleg propi acabava fent una cerca per títol i podia reproduir un
    // fitxer que no era el que s'havia triat.
    if (streamRequest.id.startsWith("gdrive:")) {
        const fileId = streamRequest.id.slice("gdrive:".length).split(":")[0];
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const file = await fetchFile(fileId, accessToken);
                if (file) {
                    const parsedFile = parseFile(file);
                    const stream = createStream(parsedFile, accessToken);
                    if (stream) {
                        console.log({ message: "Stream directe per ID intern", fileId });
                        return [stream];
                    }
                }
            }
        } catch (e) {
            console.error({ message: "Error obrint el fitxer per ID intern", fileId, error: e.toString() });
        }
        return [createErrorStream("No s'ha pogut obrir aquest fitxer")];
    }

    // ── SÈRIES ────────────────────────────────────────────────────────────
    if (esImdb && streamRequest.season && streamRequest.episode) {
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const carpetes = await findCollectionFolder(imdbId, accessToken);
                const targetSeason = parseInt(streamRequest.season, 10);
                const targetEpisode = parseInt(streamRequest.episode, 10);
                const structure = await getSeasonStructure(imdbId);

                // Provem cada carpeta candidata fins que alguna contingui
                // l'episodi. Amb una sola carpeta el comportament és el mateix.
                for (const folderId of carpetes) {
                    if (!quedaPressupost(6)) break;
                    const fitxersRuta = await walkCollectionFiles(folderId, accessToken);
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
                        message: "Cap episodi coincident en aquesta carpeta",
                        imdbId, folderId, targetSeason, targetEpisode,
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

    // Reserva: cerca per títol a Google Drive (comportament original)
    const query = await buildSearchQuery(streamRequest);
    if (!query) {
        console.log({ message: "Sense metadata: no hi ha cerca de reserva possible", id: streamRequest.id });
        return streams;
    }
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

    const nameRegex = !streamRequest.metadata?.name ? null : new RegExp(
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
            ? results.files.filter((file) => !nameRegex || nameRegex.test(file.name))
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
        INDEX_INVERS = null;
        globalThis.__ctx = ctx;

        return handleRequest(request);
    },
};
