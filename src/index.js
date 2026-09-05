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

function createStream(parsedFile, accessToken) {
    let name = parsedFile.type.startsWith("audio")
        ? `[🎵 Audio] ${MANIFEST.name} ${parsedFile.extension.toUpperCase()}`
        : `${MANIFEST.name} ${parsedFile.resolution}`;

    let description = `🎥 ${parsedFile.quality}   ${
        parsedFile.encode ? "🎞️ " + parsedFile.encode : ""
    }`;

    if (parsedFile.visualTags.length > 0 || parsedFile.audioTags.length > 0) {
        description += "\n";

        description +=
            parsedFile.visualTags.length > 0
                ? `📺 ${parsedFile.visualTags.join(" | ")}   `
                : "";
        description +=
            parsedFile.audioTags.length > 0
                ? `🎧 ${parsedFile.audioTags.join(" | ")}`
                : "";
    }

    description += `\n📦 ${parsedFile.formattedSize}`;
    if (parsedFile.languages.length !== 0) {
        description += `\n🔊 ${parsedFile.languages.join(" | ")}`;
    }

    description += `\n📄 ${parsedFile.name}`;

    if (parsedFile.duration) {
        description += `\n⏱️ ${formatDuration(parsedFile.duration)}`;
    }
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

async function getTmdbPosterByName(name) {
    if (!CONFIG.tmdbApiKey) return null;
    try {
        // 1. Extreure títol original entre parèntesis si existeix i sembla un títol real
        //    Ex: "Blau (Ai Yori Aoshi) (2002) [cat-jap]" → "Ai Yori Aoshi"
        const originalTitleMatch = name.match(/\(([A-Z][A-Za-z][\w\s:!?'&\-,.]{2,})\)/);
        // Descartar si sembla tècnic (conté FLAC, DTS, cat, etc.)
        const originalTitle = originalTitleMatch && 
            !/(?:FLAC|DTS|cat|esp|eng|jap|val|cas|mal|sub|dub|BD|HD|AVC)/i.test(originalTitleMatch[1])
            ? originalTitleMatch[1].trim() : null;
        
        // 2. Netejar nom: treure claudàtors, parèntesis amb any/codecs, extensions
        let cleanedName = name
            .replace(/\.[a-z0-9]{3,4}$/i, "")           // extensió (.mkv, .mp4, .avi)
            .replace(/\[.*?\]/g, "")                      // tot entre claudàtors [480p] [cat-jap]
            .replace(/\((\d{4})\)/g, "")                  // any sol entre parèntesis (1988)
            .replace(/\([^)]*\d{4}[^)]*\)/g, "")          // parèntesis que contenen any + porqueria (1992 480p)
            .replace(/\([^)]*(?:cat|esp|eng|jap|sub|dub|FLAC|DTS|AVC|BD|HD|by\s)[^)]*\)/gi, "")
            .replace(/\b\d{3,4}p\b/gi, "")               // resolucions 480p 1080p
            .replace(/\b(?:BDRemux|BluRay|WEB-?DL|WEBRip|HDRip|DVDRip|HDTV|CAM|REMUX|UHD|4K)\b/gi, "")
            .replace(/\b(?:x264|x265|h264|h265|HEVC|AVC|AAC|FLAC|DTS|Atmos|AC3|DoVi|HDR\d*)\b/gi, "")
            .replace(/\b(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL)(?:\s*[-]\s*(?:CAT|ESP|ENG|JAP|VAL|CAS|MAL))*\b/g, "") // CAT-VAL-CAS
            .replace(/\b(?:cat|esp|eng|jap|val|cas|mal)\b/gi, "")
            .replace(/\bby\s+\w+/gi, "")                  // "by ackman"
            .replace(/\bv\d+\b/gi, "")                    // versions v2
            .replace(/\s*M\d+\s*/g, " ")                  // M07 (número de película)
            .replace(/\bREEL\d+\b/gi, "")                 // REEL1
            .replace(/\b\d+th\s+Anniversary\b/gi, "")     // 30th Anniversary
            .replace(/\d+-\d+/g, "")                       // 4-3 (aspect ratio)
            .replace(/\s+/g, " ")
            .trim();

        // 3. Extreure any si el trobem (per refinar cerca)
        const yearMatch = name.match(/\((\d{4})\)/);
        const year = yearMatch ? yearMatch[1] : null;

        // 4. Buscar a TMDB amb fallback: títol original > títol netejat
        const queries = [];
        if (originalTitle) {
            queries.push(originalTitle);
        }
        if (cleanedName && cleanedName.length > 1) {
            queries.push(cleanedName);
        }
        if (queries.length === 0) return null;

        for (const q of queries) {
            for (const lang of ["ca", "es", "en"]) {
                const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${CONFIG.tmdbApiKey}&query=${encodeURIComponent(q)}&language=${lang}&page=1` + (year ? `&year=${year}` : "");
                const response = await fetch(searchUrl);
                if (!response.ok) continue;
                const data = await response.json();
                const result = data.results?.[0];
                if (result && (result.poster_path || result.backdrop_path)) {
                    // Obtenir IMDB ID via external_ids
                    let imdbId = null;
                    if (result.id && CONFIG.tmdbApiKey) {
                        try {
                            const mediaType = result.media_type === "movie" ? "movie" : "tv";
                            const extUrl = API_ENDPOINTS.TMDB_EXTERNAL_IDS
                                .replace("{type}", mediaType)
                                .replace("{id}", result.id)
                                .replace("{apiKey}", CONFIG.tmdbApiKey);
                            const extRes = await fetch(extUrl);
                            if (extRes.ok) {
                                const extData = await extRes.json();
                                imdbId = extData.imdb_id || null;
                            }
                        } catch (e) { /* ignore */ }
                    }
                    return {
                        poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
                        background: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : null,
                        imdbId,
                        tmdbType: result.media_type,
                    };
                }
            }
        }
        return null;
    } catch (e) {
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

const SXE_REGEX = /s(\d{1,2})[ ._-]?e(\d{1,3})/i;
const NXM_REGEX = /(\d{1,2})x(\d{1,3})/i;
const NUMERO_PLA_REGEX = /(\d{2,4})(?!\d)/;

function extreuNumeroEpisodi(nomArxiu) {
    let m = SXE_REGEX.exec(nomArxiu);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), font: "SxE" };
    m = NXM_REGEX.exec(nomArxiu);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), font: "NxM" };
    m = NUMERO_PLA_REGEX.exec(nomArxiu);
    if (m) return { season: null, episode: parseInt(m[1], 10), font: "pla" };
    return null;
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

async function handleRequest(request) {
    try {
        const url = new URL(
            decodeURIComponent(request.url).replace("%3A", ":")
        );
        globalThis.playbackUrl = url.origin + "/playback";

        if (url.pathname === "/manifest.json") {
            const manifest = MANIFEST;
            manifest.catalogs = [];
            manifest.resources = [
                { name: "stream", types: ["movie", "series", "anime"] },
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

        const createMetaObject = async (id, name, size, thumbnail, createdTime) => {
            const tmdb = await getTmdbPosterByName(name);
            const useImdb = tmdb?.imdbId;
            if (useImdb) {
                IMDB_TO_GDRIVE.set(tmdb.imdbId, { type: "movie", id: id });
            }
            return {
                id: useImdb ? tmdb.imdbId : `gdrive:${id}`,
                name,
                posterShape: "poster",
                background: tmdb?.background || thumbnail,
                poster: tmdb?.poster || thumbnail,
                description:
                    `Size: ${formatSize(size)}` +
                    (createdTime
                        ? ` | Created: ${new Date(createdTime).toLocaleDateString(
                              "en-GB",
                              {
                                  year: "numeric",
                                  month: "long",
                                  day: "numeric",
                              }
                          )}`
                        : ""),
                type: "movie",
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
                    title: ep.title,
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
                const metas = [];
                try {
                    for (const rootId of CONFIG.collectionsRootFolderIds) {
                        const subfolders = await listChildren(rootId, accessToken, {
                            onlyFolders: true,
                        });
                        const folderMetas = await Promise.all(
                            subfolders.map(async (folder) => {
                                const tmdb = await getTmdbPosterByName(folder.name);
                                if (tmdb?.imdbId) {
                                    IMDB_TO_GDRIVE.set(tmdb.imdbId, { type: "series", id: folder.id });
                                    return {
                                        id: tmdb.imdbId,
                                        type: "series",
                                        name: folder.name,
                                        posterShape: "poster",
                                        poster: tmdb.poster || null,
                                        background: tmdb.background || null,
                                    };
                                }
                                // Fallback sense IMDB: mantenir ID custom
                                return {
                                    id: `gdriveshow:${folder.id}`,
                                    type: "series",
                                    name: folder.name,
                                    posterShape: "poster",
                                    poster: tmdb?.poster || null,
                                    background: tmdb?.background || null,
                                };
                            })
                        );
                        metas.push(...folderMetas);
                    }
                } catch (error) {
                    console.error({
                        message: "Failed to list collections",
                        error: error.toString(),
                    });
                }
                console.log({
                    message: "Collections catalog response",
                    numMetas: metas.length,
                });
                return createJsonResponse({ metas });
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
                const metas = await Promise.all(results.files.map((file) =>
                    createMetaObject(
                        file.id,
                        file.name,
                        file.size,
                        file.thumbnailLink,
                        file.createdTime
                    )
                ));
                console.log({
                    message: "Catalog response",
                    numMetas: metas.length,
                });
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

                const metas = await Promise.all(results.files.map((file) =>
                    createMetaObject(
                        file.id,
                        file.name,
                        file.size,
                        file.thumbnailLink,
                        file.createdTime
                    )
                ));

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

async function getStreams(streamRequest) {
    const streams = [];
    const imdbId = streamRequest.id.split(":")[0];

    // Comprovar si tenim un mapping directe IMDB → carpeta GDrive (collections)
    const mapping = IMDB_TO_GDRIVE.get(imdbId);
    if (mapping && mapping.type === "series" && streamRequest.season && streamRequest.episode) {
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const fitxersRuta = await walkCollectionFiles(mapping.id, accessToken);
                const episodis = assignaEpisodis(fitxersRuta);
                const targetSeason = parseInt(streamRequest.season, 10);
                const targetEpisode = parseInt(streamRequest.episode, 10);
                const matches = episodis.filter(
                    (ep) => ep.season === targetSeason && ep.episode === targetEpisode
                );
                for (const match of matches) {
                    const file = match.file;
                    const parsedFile = parseFile(file);
                    const stream = createStream(parsedFile, accessToken);
                    if (stream) streams.push(stream);
                }
                if (streams.length > 0) {
                    console.log({ message: "Found streams via collection mapping", imdbId, season: targetSeason, episode: targetEpisode, count: streams.length });
                    return streams;
                }
            }
        } catch (e) {
            console.error({ message: "Error in collection stream lookup", error: e.toString() });
        }
    }

    // Comprovar si tenim un mapping directe IMDB → fitxer GDrive (pelis)
    if (mapping && mapping.type === "movie") {
        try {
            const accessToken = await getAccessToken();
            if (accessToken) {
                const file = await fetchFile(mapping.id, accessToken);
                if (file) {
                    const parsedFile = parseFile(file);
                    const stream = createStream(parsedFile, accessToken);
                    if (stream) {
                        console.log({ message: "Found stream via movie mapping", imdbId, fileId: mapping.id });
                        return [stream];
                    }
                }
            }
        } catch (e) {
            console.error({ message: "Error in movie stream lookup", error: e.toString() });
        }
    }

    // Fallback: cerca per títol a Google Drive (comportament original)
    const query = await buildSearchQuery(streamRequest);
    console.log({ message: "Built search query", query, config: CONFIG });

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
        return handleRequest(request);
    },
};
