// Caràtules i catàlegs: que cada títol surti amb la caràtula que li toca, que
// el mapa sobrevisqui entre isolates, i que cap error transitori (quota de
// subpeticions, HTTP 429, KV caigut) marqui un títol bo com a "sense caràtula".
//
// Regressions cobertes:
//  · El cron feia 8 passades en una sola invocació. Cloudflare només en dona
//    50 subpeticions per invocació: a partir de la 1a passada tot petava amb
//    "Too many subrequests", /omplir ho desava com a intent fallit i, al 3r
//    dia, el títol quedava amb la caràtula generada per sempre.
//  · Sense KV el mapa vivia a la Cache API (per centre de dades): el cron
//    escrivia en un centre i les peticions d'Espanya en llegien un altre.
//  · El catàleg de col·leccions resolia TMDB en línia i trigava ~17 s, i
//    Stremio deixava la fila en blanc.
//  · /buidar, /esborra i /admin eren oberts a qualsevol.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert").strict;

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8")
    .replace(/^export default /m, "globalThis.__worker = ")
    + `
globalThis.__t = {
    getTmdbPosterByName, cleanTitleForSearch, senseAccents, reiniciaPressupost, esSerieGermana,
    CONFIG, TMDB_CACHE,
    mapa: () => MAPA,
    caducaMapa: () => { MAPA_CARREGAT_TS = 0; },
};`;

const FOLDER = "application/vnd.google-apps.folder";
const ORIGEN = "https://stremio-gdrive-addon-cat.sillyckcanada.workers.dev";
const TOKEN = "secret-de-prova";
const LIMIT_CLOUDFLARE = 50;

// ── Fons de prova ────────────────────────────────────────────────────────────
// Noms de carpeta reals del Drive, amb la fitxa de TMDB que els correspon.
// "esperat" és l'id de TMDB que HA de guanyar quan n'hi ha més d'un candidat.
const SERIES = [
    { id: "F_3X3", nom: "3x3 Ulls (1991)", imdb: "tt0101001", esperat: 101, tmdb: [
        { id: 101, name: "3x3 Ulls", original_name: "3×3 EYES", first_air_date: "1991-07-25", poster_path: "/3x3.jpg", backdrop_path: "/3x3b.jpg", genre_ids: [16], overview: "Pai" },
    ] },
    // Remake de 2005 amb el mateix nom: l'any de la carpeta (1993) desempata
    { id: "F_AMG", nom: "Ah! My Goddess (1993)", imdb: "tt0202002", esperat: 202, tmdb: [
        { id: 201, name: "Ah! My Goddess", first_air_date: "2005-01-06", poster_path: "/amg2005.jpg", genre_ids: [16] },
        { id: 202, name: "Ah! My Goddess", first_air_date: "1993-02-21", poster_path: "/amg1993.jpg", genre_ids: [16] },
    ] },
    // Versió d'imatge real primer a TMDB: s'ha de triar la d'animació
    { id: "F_LL", nom: "Lucky Luke", imdb: "tt0303002", esperat: 302, tmdb: [
        { id: 301, name: "Lucky Luke", first_air_date: "1992-01-01", poster_path: "/ll-real.jpg", genre_ids: [37] },
        { id: 302, name: "Lucky Luke", first_air_date: "1984-09-01", poster_path: "/ll-anim.jpg", genre_ids: [16] },
    ] },
    { id: "F_11E", nom: "11eyes (sub cat)", imdb: "tt0404001", esperat: 401, tmdb: [
        { id: 401, name: "11eyes", first_air_date: "2009-10-06", poster_path: "/11eyes.jpg", genre_ids: [16] },
    ] },
    { id: "F_INU", nom: "Inuyasha [cat - esp - eng - jap]", imdb: "tt0505001", esperat: 501, tmdb: [
        { id: 501, name: "Inuyasha", first_air_date: "2000-10-16", poster_path: "/inu.jpg", genre_ids: [16] },
    ] },
    // TMDB no té res i la Viquipèdia tampoc: s'ha de mostrar amb el nom de la
    // carpeta i caràtula generada, i comptar com a intent fallit legítim
    { id: "F_AIU", nom: "Aiura (sub cat)", imdb: null, esperat: null, tmdb: [] },
    // TMDB retorna una obra SENSE relació: no s'ha d'acceptar mai
    { id: "F_DOR", nom: "Doraemon", imdb: null, esperat: null, tmdb: [
        { id: 999, name: "Dora the Explorer", first_air_date: "2000-08-14", poster_path: "/dora.jpg", genre_ids: [16] },
    ] },
    // Només la Viquipèdia en català el reconeix
    { id: "F_RUM", nom: "El món de Rumiko", imdb: "tt0707007", esperat: "viqui", tmdb: [],
      viqui: { ca: [{ title: "El món de Rumiko", pageprops: { wikibase_item: "Q707" } }] },
      wikidata: { Q707: "tt0707007" },
      find: { tv_results: [{ id: 707, name: "Rumiko Takahashi Anthology", poster_path: "/rumiko.jpg" }] } },
];

const PELIS = [
    { id: "P_AKI", nom: "Akira (1988) [CAT].mkv", imdb: "tt0094625", tmdb: [
        { id: 149, title: "Akira", release_date: "1988-07-16", media_type: "movie", poster_path: "/akira.jpg" },
    ] },
    { id: "P_5CM", nom: "5 centímetres per segon (2007).mkv", imdb: "tt0983213", tmdb: [
        { id: 38142, title: "5 centímetres per segon", release_date: "2007-03-03", media_type: "movie", poster_path: "/5cm.jpg" },
    ] },
    { id: "P_XYZ", nom: "Gravacio casolana 2003.mkv", imdb: null, tmdb: [] },
];

// ── Xarxa simulada ───────────────────────────────────────────────────────────
function json(dades, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => dades, text: async () => JSON.stringify(dades) };
}

function xarxaFalsa({ series = SERIES, pelis = PELIS, extra = {} } = {}) {
    const x = {
        crides: [],               // totes, en ordre
        perInvocacio: 0,          // es posa a 0 a cada invocació
        limit: LIMIT_CLOUDFLARE,  // límit real de subpeticions de Cloudflare
        tmdbStatus: null,         // força un HTTP d'error a TMDB (ex. 429)
        wikiStatus: null,
        drive: {
            ARREL_SERIES: series.map((s) => ({ id: s.id, name: s.nom, mimeType: FOLDER })),
            ARREL_PELIS: pelis.map((p) => ({ id: p.id, name: p.nom, mimeType: "video/x-matroska", size: "1000000" })),
            ...Object.fromEntries(series.map((s) => [s.id, []])),
            ...extra,
        },
        tmdbPerConsulta: new Map(),
        externs: new Map(),
        find: new Map(),
        viqui: new Map(),
        wikidata: new Map(),
        compta(tipus) { return this.crides.filter((c) => c.tipus === tipus).length; },
    };
    return x;
}

// Omple les respostes de TMDB i Viquipèdia a partir de les MATEIXES consultes
// que generarà el codi de producció (cleanTitleForSearch), no d'una llista
// escrita a mà que es desfasaria.
function preparaRespostes(x, t, { series = SERIES, pelis = PELIS } = {}) {
    for (const o of [...series, ...pelis]) {
        const { queries } = t.cleanTitleForSearch(o.nom);
        const totes = new Set(queries);
        for (const q of queries) totes.add(t.senseAccents(q));
        // Acumula: com TMDB, una consulta pot tornar obres de diverses
        // carpetes ("Bola de Drac" retorna la sèrie i també "Bola de Drac Z")
        for (const q of totes) {
            const previs = x.tmdbPerConsulta.get(q) || [];
            x.tmdbPerConsulta.set(q, [...previs, ...o.tmdb.filter((r) => !previs.some((p) => p.id === r.id))]);
        }
        for (const r of o.tmdb) {
            const esperat = o.esperat === undefined ? o.tmdb[0]?.id : o.esperat;
            x.externs.set(r.id, r.id === esperat ? o.imdb : `tt9${r.id}`);
        }
        for (const [lang, pagines] of Object.entries(o.viqui || {})) x.viqui.set(`${lang}:${queries[0]}`, pagines);
        for (const [qid, imdb] of Object.entries(o.wikidata || {})) x.wikidata.set(qid, imdb);
        if (o.find && o.imdb) x.find.set(o.imdb, o.find);
    }
}

async function fetchFals(x, u) {
    const s = String(u);
    const url = new URL(s);
    let tipus = "altre";
    if (url.hostname === "oauth2.googleapis.com") tipus = "token";
    else if (url.hostname === "content.googleapis.com") tipus = "drive";
    else if (url.hostname === "api.themoviedb.org") tipus = "tmdb";
    else if (url.hostname.endsWith("wikipedia.org")) tipus = "viquipedia";
    else if (url.hostname === "www.wikidata.org") tipus = "wikidata";
    else if (url.hostname === "v3-cinemeta.strem.io") tipus = "cinemeta";
    x.crides.push({ tipus, url: s });
    x.perInvocacio++;
    if (x.perInvocacio > x.limit) throw new Error("Too many subrequests.");

    if (tipus === "token") return json({ access_token: "t" });

    if (tipus === "drive") {
        const q = url.searchParams.get("q") || "";
        const tots = Object.values(x.drive).filter(Array.isArray).flat();
        // GET d'un fitxer o carpeta concrets (fetchFile)
        const directe = !q && /\/files\/([^/]+)$/.exec(url.pathname);
        if (directe) {
            const f = tots.find((i) => i.id === decodeURIComponent(directe[1]));
            return f ? json(f) : json({ error: "not found" }, 404);
        }
        // Cerca per nom (gdrive_search)
        const nom = /name contains '((?:[^'\\]|\\.)*)'/.exec(q);
        if (nom) {
            const terme = nom[1].replace(/\\'/g, "'").toLowerCase();
            return json({ files: tots.filter((f) => f.mimeType.startsWith("video/") && f.name.toLowerCase().includes(terme)) });
        }
        const pares = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
        let fills = pares.flatMap((p) => x.drive[p] || []);
        if (q.includes(`mimeType = '${FOLDER}'`)) fills = fills.filter((f) => f.mimeType === FOLDER);
        if (q.includes(`mimeType != '${FOLDER}'`)) fills = fills.filter((f) => f.mimeType !== FOLDER);
        if (q.includes("mimeType contains 'video/'")) fills = fills.filter((f) => f.mimeType.startsWith("video/"));
        return json({ files: fills });
    }

    if (tipus === "tmdb") {
        if (x.tmdbStatus) return json({ status_message: "rate limited" }, x.tmdbStatus);
        const cerca = /^\/3\/search\/(tv|movie|multi)$/.exec(url.pathname);
        if (cerca) {
            const q = url.searchParams.get("query");
            return json({ results: x.tmdbPerConsulta.get(q) || [] });
        }
        const ext = /^\/3\/(tv|movie)\/(\d+)\/external_ids$/.exec(url.pathname);
        if (ext) return json({ imdb_id: x.externs.get(Number(ext[2])) || null });
        const find = /^\/3\/find\/(tt\d+)$/.exec(url.pathname);
        if (find) return json(x.find.get(find[1]) || { movie_results: [], tv_results: [] });
    }

    if (tipus === "viquipedia") {
        if (x.wikiStatus) return json({}, x.wikiStatus);
        const lang = url.hostname.split(".")[0];
        const cerca = url.searchParams.get("gsrsearch") || "";
        // El codi afegeix l'any a la cerca; el traiem per trobar la clau
        const clau = `${lang}:${cerca.replace(/\s+(?:19|20)\d{2}$/, "")}`;
        return json({ query: { pages: x.viqui.get(clau) || [] } });
    }

    if (tipus === "cinemeta") {
        const id = /\/meta\/\w+\/(tt\d+)\.json$/.exec(url.pathname)?.[1];
        return json({ meta: { id, name: "Títol de Cinemeta", year: "2000", type: "movie" } });
    }

    if (tipus === "wikidata") {
        const ids = (url.searchParams.get("ids") || "").split("|");
        const entities = {};
        for (const id of ids) {
            const imdb = x.wikidata.get(id);
            if (imdb) entities[id] = { claims: { P345: [{ mainsnak: { datavalue: { value: imdb } } }] }, labels: {} };
        }
        return json({ entities });
    }

    throw new Error("URL no simulada: " + s);
}

// ── KV simulat ───────────────────────────────────────────────────────────────
function kvFals(inicial = null) {
    const dades = new Map();
    if (inicial) dades.set("mapa_v1", JSON.stringify(inicial));
    return {
        dades, lectures: 0, escriptures: 0, fallaLectura: false,
        async get(k, tipus) {
            this.lectures++;
            if (this.fallaLectura) throw new Error("KV no disponible");
            const v = dades.get(k);
            if (v == null) return null;
            return tipus === "json" ? JSON.parse(v) : v;
        },
        async put(k, v) { this.escriptures++; dades.set(k, v); },
        async delete(k) { dades.delete(k); },
        mapa() { const v = dades.get("mapa_v1"); return v ? JSON.parse(v) : {}; },
    };
}

// ── Isolates ─────────────────────────────────────────────────────────────────
// Cada isolate és una càrrega nova del mòdul: res en memòria compartit, com
// passa a Cloudflare entre centres de dades o quan recicla un isolate.
function nouIsolate(x, { caches } = {}) {
    const ctx = {
        console: { log: () => {}, error: () => {} },
        URL, URLSearchParams, Request, Response, Headers, TextEncoder, TextDecoder,
        setTimeout, clearTimeout, atob, btoa,
        fetch: (u) => fetchFals(x, u),
    };
    if (caches) ctx.caches = caches;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: "index.js" });
    const t = ctx.__t;
    t.CONFIG.collectionsRootFolderIds = ["ARREL_SERIES"];
    t.CONFIG.moviesFolderIds = ["ARREL_PELIS"];
    t.CONFIG.cercaPelisDinsColeccions = false;
    t.CONFIG.usaCauRecorregut = false;
    return { worker: ctx.__worker, t };
}

function entorn(kv, { admin = TOKEN, ambKv = true } = {}) {
    return {
        CLIENT_ID: "c", CLIENT_SECRET: "s", REFRESH_TOKEN: "r", TMDB_API_KEY: "k",
        ...(ambKv ? { MAPA_KV: kv } : {}),
        ...(admin ? { ADMIN_TOKEN: admin } : {}),
    };
}

async function crida(iso, x, env, ruta, opts) {
    const pendents = [];
    x.perInvocacio = 0;
    const res = await iso.worker.fetch(new Request(ORIGEN + ruta, opts), env, { waitUntil: (p) => pendents.push(p) });
    await Promise.all(pendents);
    return res;
}

async function cron(iso, x, env) {
    const pendents = [];
    x.perInvocacio = 0;
    await iso.worker.scheduled({ cron: "*/10 * * * *" }, env, { waitUntil: (p) => pendents.push(p) });
    await Promise.all(pendents);
}

async function unitat(x) {
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    iso.t.CONFIG.tmdbApiKey = "k";
    iso.t.reiniciaPressupost(46);
    x.perInvocacio = 0;
    return iso;
}

const posterTmdb = (p) => `https://image.tmdb.org/t/p/w500${p}`;
const serie = (id) => SERIES.find((s) => s.id === id);
const esperatPoster = (s) => posterTmdb(s.tmdb.find((r) => r.id === s.esperat).poster_path);

// ── Execució ─────────────────────────────────────────────────────────────────
const proves = [];
const prova = (nom, fn) => proves.push({ nom, fn });
const seccio = (nom) => proves.push({ seccio: nom });

// ═════════════════════════════════════════════════════════════════════════════
seccio("Resolució d'una caràtula (getTmdbPosterByName)");

for (const s of SERIES.filter((s) => typeof s.esperat === "number")) {
    prova(`"${s.nom}" → caràtula i IMDb correctes`, async () => {
        const x = xarxaFalsa();
        const { t } = await unitat(x);
        const r = await t.getTmdbPosterByName(s.nom, { preferTv: true });
        assert.ok(r, "hauria de trobar-lo");
        assert.equal(r.poster, esperatPoster(s));
        assert.equal(r.imdbId, s.imdb);
    });
}

prova("Ah! My Goddess: l'any de la carpeta tria l'original (1993), no el remake (2005)", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const r = await t.getTmdbPosterByName("Ah! My Goddess (1993)", { preferTv: true });
    assert.equal(r.poster, posterTmdb("/amg1993.jpg"));
});

prova("Lucky Luke: guanya la versió d'animació encara que TMDB la doni segona", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const r = await t.getTmdbPosterByName("Lucky Luke", { preferTv: true });
    assert.equal(r.poster, posterTmdb("/ll-anim.jpg"));
});

prova("Doraemon: una obra sense relació (Dora the Explorer) es rebutja", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const r = await t.getTmdbPosterByName("Doraemon", { preferTv: true });
    assert.equal(r, null);
});

// Respon a totes les consultes que el codi generarà per a "nom"
function respon(x, t, nom, results) {
    for (const q of t.cleanTitleForSearch(nom).queries) {
        x.tmdbPerConsulta.set(q, results);
        x.tmdbPerConsulta.set(t.senseAccents(q), results);
    }
    for (const r of results) x.externs.set(r.id, `tt${r.id}`);
}

prova("Cas real: la carpeta \"_CAT SUB_\" NO agafa la caràtula de \"Yemin-SUB\"", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "_CAT SUB_", [{ id: 81, name: "Yemin-SUB", first_air_date: "2021-01-01", poster_path: "/yemin.jpg", genre_ids: [] }]);
    assert.equal(await t.getTmdbPosterByName("_CAT SUB_", { preferTv: true }), null);
});

prova("Una paraula que només apareix a mig títol no basta (\"Conan\" ≠ \"Robot Conan Dies\")", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Conan", [{ id: 82, name: "Robot Conan Dies", first_air_date: "2001-01-01", poster_path: "/rcd.jpg", genre_ids: [16] }]);
    assert.equal(await t.getTmdbPosterByName("Conan", { preferTv: true }), null);
});

prova("Dues o més paraules en comú sí que casen (\"Llegenda Korra\" → \"La llegenda de Korra\")", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Llegenda Korra", [{ id: 83, name: "La llegenda de Korra", first_air_date: "2012-04-14", poster_path: "/korra.jpg", genre_ids: [16] }]);
    const r = await t.getTmdbPosterByName("Llegenda Korra", { preferTv: true });
    assert.equal(r?.poster, posterTmdb("/korra.jpg"));
});

prova("Una paraula que és l'inici del títol continua casant (\"Heidi\" → \"Heidi, la nena dels Alps\")", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Heidi", [{ id: 84, name: "Heidi, la nena dels Alps", first_air_date: "1974-01-06", poster_path: "/heidi.jpg", genre_ids: [16] }]);
    const r = await t.getTmdbPosterByName("Heidi", { preferTv: true });
    assert.equal(r?.poster, posterTmdb("/heidi.jpg"));
});

// ── Casos trobats validant els 562 títols reals contra TMDB ──────────────────
prova("Cas real: \"Summer Wars\" NO és \"LEGO Star Wars Summer Vacation\"", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Summer Wars [1080p][BDRip].mkv", [{ id: 91, title: "LEGO Star Wars Summer Vacation", release_date: "2022-08-05", media_type: "movie", poster_path: "/lego.jpg" }]);
    assert.equal(await t.getTmdbPosterByName("Summer Wars [1080p][BDRip].mkv"), null);
});

prova("Cas real: \"Tom i Jerry, Missió a Mart\" NO és \"Tom and Jerry Tales: Wild About Winter\"", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Tom i Jerry Missio a Mart.avi", [{ id: 92, title: "Tom and Jerry Tales: Wild About Winter", release_date: "2008-01-01", media_type: "movie", poster_path: "/tj.jpg" }]);
    assert.equal(await t.getTmdbPosterByName("Tom i Jerry Missio a Mart.avi"), null);
});

prova("Cas real: \"El món de Rumiko\" NO agafa \"El món de Pepe Rubianes\" pel prefix curt", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "El món de Rumiko", [{ id: 93, name: "El món de Pepe Rubianes", first_air_date: "2008-01-01", poster_path: "/pepe.jpg", genre_ids: [] }]);
    const r = await t.getTmdbPosterByName("El món de Rumiko", { preferTv: true });
    assert.notEqual(r?.poster, posterTmdb("/pepe.jpg"));
    assert.equal(r?.imdbId, "tt0707007", "ha de caure a la Viquipèdia, que sí que el coneix");
});

prova("Cas real: \"Els misteris de l'Alfred Eriçó\" NO és \"Els misteris de Lolita\"", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Els misteris de l'Alfred Eriçó", [{ id: 94, name: "Els misteris de Lolita", first_air_date: "1990-01-01", poster_path: "/lolita.jpg", genre_ids: [16] }]);
    assert.equal(await t.getTmdbPosterByName("Els misteris de l'Alfred Eriçó", { preferTv: true }), null);
});

prova("Contraprova: \"Herois a la galàxia\" continua casant amb \"La llegenda dels herois a la galàxia\"", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    respon(x, t, "Herois a la galàxia (1988).mkv", [{ id: 95, title: "La llegenda dels herois a la galàxia", release_date: "1988-02-05", media_type: "movie", poster_path: "/lotgh.jpg" }]);
    const r = await t.getTmdbPosterByName("Herois a la galàxia (1988).mkv");
    assert.equal(r?.poster, posterTmdb("/lotgh.jpg"));
});

prova("Contraprova: el curt sí que val si és el títol exacte (\"Bola de Drac\" dins un nom llarg)", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const nom = "Bola de Drac Remasteritzada Integral Completa";
    const { curt } = t.cleanTitleForSearch(nom);
    assert.equal(curt, "Bola de Drac");
    for (const q of t.cleanTitleForSearch(nom).queries) x.tmdbPerConsulta.set(q, []);
    x.tmdbPerConsulta.set(curt, [{ id: 96, name: "Bola de Drac", first_air_date: "1986-02-26", poster_path: "/bdd.jpg", genre_ids: [16] }]);
    x.externs.set(96, "tt0088509");
    const r = await t.getTmdbPosterByName(nom, { preferTv: true });
    assert.equal(r?.poster, posterTmdb("/bdd.jpg"));
});

prova("Cas real: \"Macross Plus (OVAs)\" no fa servir \"OVAs\" com a títol original", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const { queries } = t.cleanTitleForSearch("Macross Plus (OVAs)");
    assert.ok(!queries.some((q) => /^ovas?$/i.test(q)), JSON.stringify(queries));
    assert.ok(queries.includes("Macross Plus"), JSON.stringify(queries));
});

prova("Pel·lícula (cerca multi): Akira → caràtula i IMDb correctes", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const r = await t.getTmdbPosterByName("Akira (1988) [CAT].mkv");
    assert.equal(r.poster, posterTmdb("/akira.jpg"));
    assert.equal(r.imdbId, "tt0094625");
});

prova("Títol que només coneix la Viquipèdia → IMDb de Wikidata i caràtula de TMDB per ID", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    const r = await t.getTmdbPosterByName("El món de Rumiko", { preferTv: true });
    assert.equal(r.imdbId, "tt0707007");
    assert.equal(r.poster, posterTmdb("/rumiko.jpg"));
});

prova("Títol que ningú té → null (definitiu) i queda a la memòria cau", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    assert.equal(await t.getTmdbPosterByName("Aiura (sub cat)", { preferTv: true }), null);
    const abans = x.crides.length;
    assert.equal(await t.getTmdbPosterByName("Aiura (sub cat)", { preferTv: true }), null);
    assert.equal(x.crides.length, abans, "la 2a vegada no ha de tornar a preguntar");
});

prova("TMDB respon 429 → undefined (NO és 'no trobat') i NO es desa a la memòria cau", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    x.tmdbStatus = 429;
    assert.equal(await t.getTmdbPosterByName("Akira (1988) [CAT].mkv"), undefined);
    x.tmdbStatus = null;
    t.reiniciaPressupost(46);
    const r = await t.getTmdbPosterByName("Akira (1988) [CAT].mkv");
    assert.equal(r?.imdbId, "tt0094625", "en recuperar-se TMDB s'ha de tornar a buscar i trobar");
});

prova("Error 'Too many subrequests' de Cloudflare → undefined", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    x.limit = 0;
    assert.equal(await t.getTmdbPosterByName("Akira (1988) [CAT].mkv"), undefined);
});

prova("Sense pressupost per començar → undefined", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    t.reiniciaPressupost(2);
    assert.equal(await t.getTmdbPosterByName("Akira (1988) [CAT].mkv"), undefined);
});

prova("Troba la fitxa però no queda pressupost per l'IMDb ID → undefined (no es desa a mitges)", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    // 1 per la cerca; quedaPressupost(2) exigeix >2 per a l'IMDb ID
    t.reiniciaPressupost(6);
    const r = await t.getTmdbPosterByName("Akira (1988) [CAT].mkv");
    assert.ok(r === undefined || r?.imdbId === "tt0094625", "o complet o res, mai a mitges");
    t.reiniciaPressupost(3);
    t.TMDB_CACHE.clear();
    assert.equal(await t.getTmdbPosterByName("Akira (1988) [CAT].mkv"), undefined);
});

prova("Viquipèdia caiguda (HTTP 500) i TMDB sense match → undefined, no null", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    x.wikiStatus = 500;
    assert.equal(await t.getTmdbPosterByName("Aiura (sub cat)", { preferTv: true }), undefined);
});

prova("Sense TMDB_API_KEY → undefined (configuració, no un fracàs del títol)", async () => {
    const x = xarxaFalsa();
    const { t } = await unitat(x);
    t.CONFIG.tmdbApiKey = null;
    assert.equal(await t.getTmdbPosterByName("Akira (1988) [CAT].mkv"), undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("/omplir: només es desa el que s'ha pogut buscar de debò");

prova("Tots els títols trobables queden al mapa amb la caràtula i l'IMDb correctes", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    for (let i = 0; i < 4; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t);
        await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    }
    const m = kv.mapa();
    for (const s of SERIES) {
        const e = m["s:" + s.id];
        assert.ok(e, `${s.nom} hauria de ser al mapa`);
        if (s.esperat === null) {
            assert.equal(e.imdbId, null, `${s.nom} no s'ha d'assignar a res`);
        } else if (s.esperat === "viqui") {
            assert.equal(e.imdbId, s.imdb);
            assert.equal(e.poster, posterTmdb("/rumiko.jpg"));
        } else {
            assert.equal(e.imdbId, s.imdb, s.nom);
            assert.equal(e.poster, esperatPoster(s), s.nom);
        }
    }
    for (const p of PELIS) {
        const e = m["m:" + p.id];
        assert.ok(e, `${p.nom} hauria de ser al mapa`);
        assert.equal(e.imdbId, p.imdb, p.nom);
    }
});

prova("TMDB amb 429 durant una passada → cap títol enverinat (ni entrada ni intents)", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    x.tmdbStatus = 429;
    await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    const m = kv.mapa();
    const enverinades = Object.entries(m).filter(([k, v]) => !k.startsWith("__") && v?.intents);
    assert.deepEqual(enverinades, [], "cap títol pot quedar marcat com a intent fallit per un 429");
});

prova("Quota de Cloudflare esgotada a mitja passada → els no mirats no s'escriuen", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    x.limit = 14;   // el Cloudflare real talla abans que el nostre comptador
    await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    const legitims = [serie("F_AIU").id, serie("F_DOR").id, PELIS[2].id];
    for (const [k, v] of Object.entries(kv.mapa())) {
        if (k.startsWith("__")) continue;
        assert.ok(!v.intents || legitims.some((id) => k.endsWith(id)),
            `${k} marcat com a fallit per culpa de la quota`);
    }
});

prova("Un títol que de debò no existeix es reintenta 3 vegades i després es deixa estar", async () => {
    const x = xarxaFalsa({ series: [serie("F_AIU")], pelis: [] });
    const kv = kvFals();
    for (let i = 1; i <= 5; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: [serie("F_AIU")], pelis: [] });
        const abans = x.compta("tmdb");
        await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
        const intents = kv.mapa()["s:F_AIU"].intents;
        assert.equal(intents, Math.min(i, 3), `passada ${i}`);
        if (i > 3) assert.equal(x.compta("tmdb"), abans, "passat el 3r intent ja no ha de gastar crides");
    }
});

prova("Col·lecció amb pel·lícules: si la quota s'acaba a mitges NO es marca com a revisada", async () => {
    const extra = {
        F_3X3: [{ id: "F_3X3_P", name: "Pel·lícules", mimeType: FOLDER }],
        F_3X3_P: Array.from({ length: 12 }, (_, i) => ({ id: `P3_${i}`, name: `3x3 Ulls Film ${i + 1}.mkv`, mimeType: "video/x-matroska", size: "1" })),
    };
    const x = xarxaFalsa({ extra, pelis: [] });
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { pelis: [] });
    iso.t.CONFIG.cercaPelisDinsColeccions = true;
    await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    const m = kv.mapa();
    const fetes = Object.keys(m).filter((k) => k.startsWith("m:P3_")).length;
    const revisades = m.__coleccionsRevisades || [];
    assert.ok(fetes < 12, "la prova ha d'esgotar el pressupost a mitja col·lecció");
    assert.ok(!revisades.includes("F_3X3"), "amb pel·lícules pendents no pot constar com a revisada");
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Cron (scheduled): una passada per invocació, dins el límit real");

prova("Una invocació del cron no supera mai les 50 subpeticions de Cloudflare", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    x.limit = Infinity;   // per mesurar-ho, no per tallar-ho
    await cron(iso, x, entorn(kv));
    assert.ok(x.perInvocacio <= LIMIT_CLOUDFLARE, `ha fet ${x.perInvocacio} subpeticions`);
});

prova("Amb 30 sèries, invocacions successives del cron omplen el mapa sencer i sense enverinar-lo", async () => {
    const moltes = Array.from({ length: 30 }, (_, i) => ({
        id: `S${i}`, nom: `Serie Prova ${i} (2001)`, imdb: `tt55${String(i).padStart(5, "0")}`,
        tmdb: [{ id: 5000 + i, name: `Serie Prova ${i}`, first_air_date: "2001-01-01", poster_path: `/s${i}.jpg`, genre_ids: [16] }],
    }));
    const x = xarxaFalsa({ series: moltes, pelis: [] });
    const kv = kvFals();
    let invocacions = 0;
    for (; invocacions < 20; invocacions++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: moltes, pelis: [] });
        await cron(iso, x, entorn(kv));
        const m = kv.mapa();
        if (moltes.every((s) => m["s:" + s.id]?.imdbId)) break;
    }
    const m = kv.mapa();
    for (const s of moltes) {
        assert.equal(m["s:" + s.id]?.imdbId, s.imdb, s.nom);
        assert.equal(m["s:" + s.id]?.poster, posterTmdb(s.tmdb[0].poster_path), s.nom);
        assert.ok(!m["s:" + s.id]?.intents, `${s.nom} no pot tenir intents fallits`);
    }
    assert.ok(invocacions < 20, "hauria d'haver acabat");
});

prova("El cron crida /omplir intern sense token i no queda bloquejat per l'autenticació", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    await cron(iso, x, entorn(kv));
    assert.ok(Object.keys(kv.mapa()).length > 0, "el cron ha d'haver escrit al mapa");
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Catàlegs amb KV: llegeixen el mapa, no resolen en línia");

async function mapaResolt(x) {
    const kv = kvFals();
    for (let i = 0; i < 4; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t);
        await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    }
    return kv;
}

prova("Col·leccions: cap crida a TMDB ni a la Viquipèdia", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const abans = x.compta("tmdb") + x.compta("viquipedia");
    const res = await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json");
    assert.equal(res.status, 200);
    assert.equal(x.compta("tmdb") + x.compta("viquipedia"), abans);
});

prova("Col·leccions: cada sèrie resolta surt amb el seu IMDb i la seva caràtula", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    for (const s of SERIES.filter((s) => typeof s.esperat === "number")) {
        const m = metas.find((mm) => mm.id === s.imdb);
        assert.ok(m, `${s.nom} hauria de sortir amb id ${s.imdb}`);
        assert.equal(m.poster, esperatPoster(s), s.nom);
        assert.equal(m.posterShape, "poster");
        assert.match(m.name, /\[CAT\]$/);
    }
});

prova("Col·leccions: les no resoltes surten amb el nom de la carpeta i caràtula generada", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    for (const s of [serie("F_AIU"), serie("F_DOR")]) {
        const m = metas.find((mm) => mm.id === `gdriveshow:${s.id}`);
        assert.ok(m, `${s.nom} ha de sortir igualment`);
        assert.ok(m.poster.startsWith(`${ORIGEN}/poster?t=`), `${s.nom}: caràtula generada`);
        assert.ok(m.name.startsWith(s.nom), `${s.nom}: nom de la carpeta`);
    }
    // I la de Dora the Explorer NO pot aparèixer enlloc
    assert.ok(!metas.some((mm) => mm.poster === posterTmdb("/dora.jpg")));
});

prova("Col·leccions: cap sèrie duplicada ni perduda", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    assert.equal(metas.length, SERIES.length);
    assert.equal(new Set(metas.map((m) => m.id)).size, SERIES.length);
});

prova("Pel·lícules: cap crida a TMDB i les resoltes surten amb IMDb i caràtula", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const abans = x.compta("tmdb");
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/movie/gdrive_list.json")).json();
    assert.equal(x.compta("tmdb"), abans);
    const akira = metas.find((m) => m.id === "tt0094625");
    assert.equal(akira?.poster, posterTmdb("/akira.jpg"));
    const cm = metas.find((m) => m.id === "tt0983213");
    assert.equal(cm?.poster, posterTmdb("/5cm.jpg"));
    const desconeguda = metas.find((m) => m.id === "gdrive:P_XYZ");
    assert.ok(desconeguda?.poster.startsWith(`${ORIGEN}/poster?t=`));
});

prova("Amb el mapa encara buit, el catàleg respon igualment i no fa cap cerca", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    assert.equal(metas.length, SERIES.length);
    assert.equal(x.compta("tmdb"), 0);
    assert.equal(kv.escriptures, 0, "un catàleg no ha d'escriure al KV");
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Persistència entre isolates (el bug de la Cache API)");

prova("El que resol el cron en un isolate ho veu el catàleg en un altre isolate", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const cronIso = nouIsolate(x);
    preparaRespostes(x, cronIso.t);
    await cron(cronIso, x, entorn(kv));
    const resoltes = Object.entries(kv.mapa()).filter(([k, v]) => k.startsWith("s:") && v?.imdbId);
    assert.ok(resoltes.length > 0);
    const catIso = nouIsolate(x);
    const { metas } = await (await crida(catIso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    for (const [, v] of resoltes) {
        assert.ok(metas.some((m) => m.id === v.imdbId && m.poster === v.poster), `falta ${v.title}`);
    }
});

prova("Un isolate calent veu les escriptures noves del cron quan caduca la seva còpia", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const catIso = nouIsolate(x);
    preparaRespostes(x, catIso.t);
    const primer = await (await crida(catIso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    assert.ok(!primer.metas.some((m) => m.id.startsWith("tt")));
    const cronIso = nouIsolate(x);
    preparaRespostes(x, cronIso.t);
    await cron(cronIso, x, entorn(kv));
    catIso.t.caducaMapa();   // han passat els 60 s de frescor
    const segon = await (await crida(catIso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    assert.ok(segon.metas.some((m) => m.id.startsWith("tt")), "ha de veure el que ha resolt el cron");
});

prova("Si la lectura del KV falla, no se sobreescriu el mapa persistent", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const abans = kv.dades.get("mapa_v1");
    const escriptures = kv.escriptures;
    kv.fallaLectura = true;
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    await crida(iso, x, entorn(kv), `/omplir?token=${TOKEN}`);
    assert.equal(kv.escriptures, escriptures, "no hi pot haver cap escriptura");
    assert.equal(kv.dades.get("mapa_v1"), abans);
});

prova("/versio indica que el mapa és a KV", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    const d = await (await crida(iso, x, entorn(kvFals()), "/versio")).json();
    assert.equal(d.emmagatzematgeMapa, "KV");
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Sense KV: el comportament anterior es manté com a reserva");

prova("Sense KV el catàleg continua resolent en línia (màxim 7 per petició)", async () => {
    const moltes = Array.from({ length: 12 }, (_, i) => ({
        id: `S${i}`, nom: `Serie Reserva ${i}`, imdb: `tt66${String(i).padStart(5, "0")}`,
        tmdb: [{ id: 6000 + i, name: `Serie Reserva ${i}`, first_air_date: "2001-01-01", poster_path: `/r${i}.jpg`, genre_ids: [16] }],
    }));
    const x = xarxaFalsa({ series: moltes, pelis: [] });
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { series: moltes, pelis: [] });
    const { metas } = await (await crida(iso, x, entorn(null, { ambKv: false }), "/catalog/series/gdrive_collections.json")).json();
    const resoltes = metas.filter((m) => m.id.startsWith("tt")).length;
    assert.ok(resoltes > 0 && resoltes <= 7, `n'ha resolt ${resoltes}`);
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Escala real: 300 carpetes amb el mapa buit (el bloqueig de producció)");

// Mateixa escala que el Drive real (296 sèries). Amb 8 carpetes no es veia:
// la detecció de franquícies (1 crida a Drive per carpeta) es menjava les 50
// subpeticions abans d'arribar a TMDB, no es desava res i cada passada
// tornava a començar igual. En producció el mapa es va quedar a 0 entrades.
function moltesSeries(n, prefix = "Serie Gran") {
    return Array.from({ length: n }, (_, i) => ({
        id: `G${i}`, nom: `${prefix} ${i} (2001)`, imdb: `tt77${String(i).padStart(5, "0")}`,
        tmdb: [{ id: 7000 + i, name: `${prefix} ${i}`, first_air_date: "2001-01-01", poster_path: `/g${i}.jpg`, genre_ids: [16] }],
    }));
}

prova("Amb 300 carpetes i el mapa buit, UNA passada del cron ja resol títols", async () => {
    const grans = moltesSeries(300);
    const x = xarxaFalsa({ series: grans, pelis: [] });
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { series: grans, pelis: [] });
    await cron(iso, x, entorn(kv));
    const resoltes = Object.entries(kv.mapa()).filter(([k, v]) => k.startsWith("s:") && v?.imdbId).length;
    assert.ok(resoltes >= 5, `només n'ha resolt ${resoltes}`);
    assert.ok(x.perInvocacio <= LIMIT_CLOUDFLARE, `${x.perInvocacio} subpeticions`);
});

prova("Amb 300 carpetes, el cron les acaba resolent TOTES amb la caràtula correcta", async () => {
    const grans = moltesSeries(300);
    const x = xarxaFalsa({ series: grans, pelis: [] });
    const kv = kvFals();
    let passades = 0;
    for (; passades < 80; passades++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: grans, pelis: [] });
        await cron(iso, x, entorn(kv));
        assert.ok(x.perInvocacio <= LIMIT_CLOUDFLARE, `passada ${passades}: ${x.perInvocacio} subpeticions`);
        const m = kv.mapa();
        if (grans.every((s) => m["s:" + s.id]?.imdbId)) break;
    }
    const m = kv.mapa();
    const falten = grans.filter((s) => m["s:" + s.id]?.poster !== posterTmdb(s.tmdb[0].poster_path));
    assert.equal(falten.length, 0, `en falten ${falten.length} després de ${passades} passades`);
});

prova("Catàleg de 300 carpetes amb el mapa buit: ràpid (≤ 3 crides externes, cap a TMDB)", async () => {
    const grans = moltesSeries(300);
    const x = xarxaFalsa({ series: grans, pelis: [] });
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { series: grans, pelis: [] });
    const res = await crida(iso, x, entorn(kvFals()), "/catalog/series/gdrive_collections.json");
    const { metas } = await res.json();
    assert.equal(metas.length, 300);
    assert.equal(x.compta("tmdb"), 0);
    assert.ok(x.perInvocacio <= 3, `${x.perInvocacio} crides externes per un catàleg`);
});

prova("Franquícia: la detecció es desa i el catàleg en mostra les sèries per separat", async () => {
    const extra = {
        ARREL_SERIES: [{ id: "F_BDD", name: "Bola de Drac", mimeType: FOLDER }],
        F_BDD: [
            { id: "F_BDD_1", name: "Bola de Drac", mimeType: FOLDER },
            { id: "F_BDD_Z", name: "Bola de Drac Z", mimeType: FOLDER },
        ],
        F_BDD_1: [], F_BDD_Z: [],
    };
    const bdd = [
        { id: "F_BDD_1", nom: "Bola de Drac", imdb: "tt0088509", tmdb: [{ id: 12609, name: "Bola de Drac", first_air_date: "1986-02-26", poster_path: "/bdd.jpg", genre_ids: [16] }] },
        { id: "F_BDD_Z", nom: "Bola de Drac Z", imdb: "tt0121220", tmdb: [{ id: 12971, name: "Bola de Drac Z", first_air_date: "1989-04-26", poster_path: "/bddz.jpg", genre_ids: [16] }] },
    ];
    const x = xarxaFalsa({ series: [], pelis: [], extra });
    const kv = kvFals();
    for (let i = 0; i < 3; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: bdd, pelis: [] });
        await cron(iso, x, entorn(kv));
    }
    const iso = nouIsolate(x);
    const abansDrive = x.compta("drive");
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/series/gdrive_collections.json")).json();
    assert.deepEqual(metas.map((m) => m.id).sort(), ["tt0088509", "tt0121220"]);
    assert.ok(x.compta("drive") - abansDrive <= 1, "el catàleg no ha de tornar a detectar la franquícia");
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Caràtula a demanda: els títols encara no resolts mostren la caràtula real");

prova("Catàleg: sèrie encara no resolta → caràtula a demanda (r=tv), no el text generat", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const { metas } = await (await crida(iso, x, entorn(kvFals()), "/catalog/series/gdrive_collections.json")).json();
    const tres = metas.find((m) => m.id === "gdriveshow:F_3X3");
    assert.equal(tres.poster, `${ORIGEN}/poster?t=${encodeURIComponent("3x3 Ulls (1991)")}&r=tv`);
});

prova("Catàleg: pel·lícula encara no resolta → caràtula a demanda (r=pelicula)", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const { metas } = await (await crida(iso, x, entorn(kvFals()), "/catalog/movie/gdrive_list.json")).json();
    const akira = metas.find((m) => m.id === "gdrive:P_AKI");
    assert.equal(akira.poster, `${ORIGEN}/poster?t=${encodeURIComponent("Akira (1988) [CAT].mkv")}&r=pelicula`);
});

prova("/poster a demanda → redirigeix a la caràtula real de TMDB", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const res = await crida(iso, x, entorn(kvFals()), `/poster?t=${encodeURIComponent("3x3 Ulls (1991)")}&r=tv`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), posterTmdb("/3x3.jpg"));
    assert.match(res.headers.get("Cache-Control") || "", /max-age=\d{5,}/);
});

prova("/poster a demanda per a una pel·lícula → caràtula real", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const res = await crida(iso, x, entorn(kvFals()), `/poster?t=${encodeURIComponent("Akira (1988) [CAT].mkv")}&r=pelicula`, { redirect: "manual" });
    assert.equal(res.headers.get("Location"), posterTmdb("/akira.jpg"));
});

prova("/poster a demanda d'un títol que no existeix → text generat (només aleshores)", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const res = await crida(iso, x, entorn(kvFals()), `/poster?t=${encodeURIComponent("Aiura (sub cat)")}&r=tv`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/png");
});

prova("/poster a demanda amb TMDB caigut → text generat però SENSE memòria cau (es reintentarà)", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    x.tmdbStatus = 429;
    const res = await crida(iso, x, entorn(kvFals()), `/poster?t=${encodeURIComponent("3x3 Ulls (1991)")}&r=tv`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
});

prova("/poster sense r → text generat directe, sense cap crida a TMDB", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const res = await crida(iso, x, entorn(kvFals()), `/poster?t=Qualsevol`);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(x.compta("tmdb"), 0);
});

prova("Fitxa de sèrie (meta) d'un títol resolt surt amb la seva caràtula, també en un isolate nou", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const { meta } = await (await crida(iso, x, entorn(kv), "/meta/series/gdriveshow:F_3X3.json")).json();
    assert.equal(meta.poster, posterTmdb("/3x3.jpg"));
});

prova("Fitxa de pel·lícula (meta) no escriu el mapa (només el cron i l'admin hi escriuen)", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const escriptures = kv.escriptures;
    const iso = nouIsolate(x);
    await crida(iso, x, entorn(kv), "/meta/movie/gdrive:P_AKI.json");
    await crida(iso, x, entorn(kv), "/catalog/movie/gdrive_list.json");
    assert.equal(kv.escriptures, escriptures);
});

prova("Un isolate amb una fitxa oberta no pot esborrar el que ha resolt el cron", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    await crida(iso, x, entorn(kv), "/meta/movie/gdrive:P_AKI.json");
    const cronIso = nouIsolate(x);
    preparaRespostes(x, cronIso.t);
    await cron(cronIso, x, entorn(kv));
    const desprésCron = Object.keys(kv.mapa()).length;
    await crida(iso, x, entorn(kv), "/catalog/movie/gdrive_list.json");
    assert.ok(Object.keys(kv.mapa()).length >= desprésCron, "el mapa ha perdut entrades");
});

prova("Cerca amb KV: no resol en línia ni escriu; els no resolts surten amb caràtula a demanda", async () => {
    const x = xarxaFalsa();
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t);
    const { metas } = await (await crida(iso, x, entorn(kv), "/catalog/movie/gdrive_search/search=akira.json")).json();
    assert.ok(metas.length > 0, "la cerca ha de trobar Akira al Drive");
    assert.equal(kv.escriptures, 0);
    assert.equal(x.compta("tmdb"), 0);
    assert.ok(metas.every((m) => m.poster.includes("&r=pelicula")), JSON.stringify(metas.map((m) => m.poster)));
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Pel·lícules: una sola caràtula per obra, totes les còpies a dins");

// Noms de fitxer reals del Drive
const CM = { tmdb: [{ id: 38142, title: "5 centímetres per segon", release_date: "2007-03-03", media_type: "movie", poster_path: "/5cm.jpg" }], imdb: "tt0983213" };
const AK = { tmdb: [{ id: 149, title: "Akira", release_date: "1988-07-16", media_type: "movie", poster_path: "/akira.jpg" }], imdb: "tt0094625" };
const COPIES = [
    { id: "C1", nom: "5 centimetres per segon (2007) [cat-jap-esp][1080p WebDL AnimeBox].mkv", ...CM },
    { id: "C2", nom: "5 centímetres per segon [1080p BD Remux][Cat-Esp-Jap][dani98].mkv", ...CM },
    { id: "C3", nom: "5 centímetres per segon [CAT].mp4", ...CM },
    { id: "A1", nom: "Akira (1988) [4K esp-cat-eng-jap].mkv", ...AK },
    { id: "A2", nom: "Akira (1988) [BDRemux AVC 1080p DTS-HD MA 5.1 Esp-Cat TrueHD 5.1 Jap].mkv", ...AK },
    // Remakes: mateix títol, anys diferents → dues obres
    { id: "L1", nom: "Aladí (1992) [cat].mkv", imdb: "tt0103639",
      tmdb: [{ id: 812, title: "Aladí", release_date: "1992-11-25", media_type: "movie", poster_path: "/aladi92.jpg" }] },
    { id: "L2", nom: "Aladí (2019) [1080p].mkv", imdb: "tt6139732",
      tmdb: [{ id: 420817, title: "Aladí", release_date: "2019-05-22", media_type: "movie", poster_path: "/aladi19.jpg" }] },
    // El cas que ja havia fet mal: un extra NO és la pel·lícula
    { id: "P1", nom: "Plastic Little.mkv", imdb: null, tmdb: [] },
    { id: "P2", nom: "Plastic Little Promotional Video.mkv", imdb: null, tmdb: [] },
];

async function catalegPelis(x, kv) {
    const iso = nouIsolate(x);
    return (await (await crida(iso, x, entorn(kv), "/catalog/movie/gdrive_list.json")).json()).metas;
}

prova("Sense resoldre: les 3 còpies de \"5 centímetres per segon\" són UNA entrada", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const metas = await catalegPelis(x, kvFals());
    const cm = metas.filter((m) => /centimetres|centímetres/i.test(m.name));
    assert.equal(cm.length, 1, JSON.stringify(cm.map((m) => m.name)));
    assert.equal(cm[0].id, "gdrive:C1:C2:C3");
    assert.match(cm[0].description, /^3 versions disponibles/);
});

prova("Sense resoldre: les 2 còpies d'Akira són UNA entrada", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const metas = await catalegPelis(x, kvFals());
    const ak = metas.filter((m) => /akira/i.test(m.name));
    assert.equal(ak.length, 1);
    assert.equal(ak[0].id, "gdrive:A1:A2");
});

prova("Remakes amb anys diferents (Aladí 1992 / 2019) NO es fusionen", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const metas = await catalegPelis(x, kvFals());
    assert.equal(metas.filter((m) => /alad/i.test(m.name)).length, 2);
});

prova("Un extra (\"Plastic Little Promotional Video\") NO es fusiona amb la pel·lícula", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const metas = await catalegPelis(x, kvFals());
    assert.equal(metas.filter((m) => /plastic little/i.test(m.name)).length, 2);
});

prova("Cap entrada mostra el nom del fitxer cru (sense extensió ni etiquetes de qualitat)", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const metas = await catalegPelis(x, kvFals());
    for (const m of metas) {
        assert.doesNotMatch(m.name, /\.(mkv|mp4|avi)\b|1080p|BDRemux|WebDL|dani98/i, m.name);
    }
    assert.ok(metas.some((m) => m.name === "5 centimetres per segon (2007) [CAT]"), JSON.stringify(metas.map((m) => m.name)));
    assert.ok(metas.some((m) => m.name === "Akira (1988) [CAT]"));
});

prova("Obrir l'entrada agrupada → Stremio pot triar entre les 3 còpies", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const iso = nouIsolate(x);
    const { streams } = await (await crida(iso, x, entorn(kvFals()), "/stream/movie/gdrive:C1:C2:C3.json")).json();
    assert.equal(streams.length, 3);
});

prova("Fitxa de l'entrada agrupada: títol net, mateix ID i nombre de versions", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const iso = nouIsolate(x);
    const { meta } = await (await crida(iso, x, entorn(kvFals()), "/meta/movie/gdrive:A1:A2.json")).json();
    assert.equal(meta.id, "gdrive:A1:A2");
    assert.equal(meta.name, "Akira (1988) [CAT]");
    assert.match(meta.description, /^2 versions disponibles/);
});

prova("Un cop resoltes: UNA entrada amb l'IMDb, que obre la fitxa rica de Cinemeta/AIOMetadata", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const kv = kvFals();
    for (let i = 0; i < 3; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: [], pelis: COPIES });
        await cron(iso, x, entorn(kv));
    }
    const metas = await catalegPelis(x, kv);
    assert.equal(metas.filter((m) => m.id === "tt0983213").length, 1);
    assert.equal(metas.filter((m) => m.id === "tt0094625").length, 1);
    assert.ok(!metas.some((m) => /^gdrive:C|^gdrive:A/.test(m.id)), "no hi pot haver còpies soltes");
    assert.equal(metas.find((m) => m.id === "tt0983213").poster, posterTmdb("/5cm.jpg"));
    // Les dues Aladí queden separades i cadascuna amb la seva caràtula
    assert.equal(metas.find((m) => m.id === "tt0103639")?.poster, posterTmdb("/aladi92.jpg"));
    assert.equal(metas.find((m) => m.id === "tt6139732")?.poster, posterTmdb("/aladi19.jpg"));
});

prova("Un cop resoltes: obrir-la per IMDb llista TOTES les còpies per triar", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const kv = kvFals();
    for (let i = 0; i < 3; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: [], pelis: COPIES });
        await cron(iso, x, entorn(kv));
    }
    const iso = nouIsolate(x);
    const { streams } = await (await crida(iso, x, entorn(kv), "/stream/movie/tt0983213.json")).json();
    assert.equal(streams.length, 3, JSON.stringify(streams.map((s) => s.name || s.title)));
});

prova("El cron resol les còpies d'un mateix títol amb UNA sola cerca", async () => {
    const x = xarxaFalsa({ series: [], pelis: COPIES });
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { series: [], pelis: COPIES });
    await cron(iso, x, entorn(kv));
    const cerquesAkira = x.crides.filter((c) => c.tipus === "tmdb" && /search/.test(c.url) && /query=Akira/.test(c.url)).length;
    assert.equal(cerquesAkira, 1);
    const m = kv.mapa();
    assert.equal(m["m:A1"]?.imdbId, "tt0094625");
    assert.equal(m["m:A2"]?.imdbId, "tt0094625");
});

prova("Amb 300 sèries pendents, les pel·lícules també avancen a cada passada", async () => {
    const grans = moltesSeries(300);
    const x = xarxaFalsa({ series: grans, pelis: COPIES });
    const kv = kvFals();
    const iso = nouIsolate(x);
    preparaRespostes(x, iso.t, { series: grans, pelis: COPIES });
    await cron(iso, x, entorn(kv));
    const pelis = Object.entries(kv.mapa()).filter(([k, v]) => k.startsWith("m:") && v?.imdbId).length;
    assert.ok(pelis >= 3, `només ${pelis} pel·lícules resoltes`);
    assert.ok(x.perInvocacio <= LIMIT_CLOUDFLARE);
});

prova("Amb el mapa complet, el cron cada minut no escriu al KV (límit de 1.000 escriptures/dia)", async () => {
    const x = xarxaFalsa({ series: [serie("F_3X3")], pelis: COPIES.slice(0, 2) });
    const kv = kvFals();
    for (let i = 0; i < 4; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: [serie("F_3X3")], pelis: COPIES.slice(0, 2) });
        iso.t.CONFIG.cercaPelisDinsColeccions = true;
        await cron(iso, x, entorn(kv));
    }
    const escriptures = kv.escriptures;
    for (let i = 0; i < 5; i++) {
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t, { series: [serie("F_3X3")], pelis: COPIES.slice(0, 2) });
        iso.t.CONFIG.cercaPelisDinsColeccions = true;
        await cron(iso, x, entorn(kv));
    }
    assert.equal(kv.escriptures, escriptures, `${kv.escriptures - escriptures} escriptures sense canvis`);
});

prova("Fitxa d'una franquícia (ID amb \"+\") s'obre en lloc de donar 400", async () => {
    const x = xarxaFalsa({ series: [], pelis: [], extra: { F_X1: [], F_X2: [], ARREL_SERIES: [
        { id: "F_X1", name: "Inuyasha", mimeType: FOLDER }, { id: "F_X2", name: "Inuyasha Pelis", mimeType: FOLDER }] } });
    const iso = nouIsolate(x);
    const res = await crida(iso, x, entorn(kvFals()), `/meta/series/${encodeURIComponent("gdriveshow:F_X1+F_X2")}.json`);
    assert.equal(res.status, 200);
});

// ═════════════════════════════════════════════════════════════════════════════
seccio("Sèries germanes vs. la mateixa sèrie amb una altra convenció de nom");

for (const [carpeta, titol, germana] of [
    ["Inazuma Eleven T1xC", "inazuma eleven", false],
    ["Inazuma Eleven S01", "inazuma eleven", false],
    ["Inazuma Eleven S01E", "inazuma eleven", false],
    ["Inazuma Eleven 1x", "inazuma eleven", false],
    ["Inazuma Eleven Go", "inazuma eleven", true],
    ["Bola de Drac Z", "bola de drac", true],
    ["Bola de Drac GT", "bola de drac", true],
    ["Bola de Drac Saga Freezer", "bola de drac", false],
    ["Bola de Drac Temporada 1", "bola de drac", false],
    ["One Piece [501-1000]", "one piece", false],
]) {
    prova(`"${carpeta}" ${germana ? "ÉS" : "no és"} una sèrie germana de "${titol}"`, async () => {
        const iso = nouIsolate(xarxaFalsa());
        assert.equal(iso.t.esSerieGermana(carpeta, [titol]), germana);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
seccio("Administració protegida");

for (const [ruta, opts] of [
    ["/buidar", {}], ["/buidar", { method: "OPTIONS" }], ["/esborra?clau=s:F_3X3", {}],
    ["/omplir", {}], ["/admin", {}], ["/admin/dades", {}], ["/admin/cerca?q=akira", {}],
    ["/admin/assigna", { method: "POST", body: "{}" }], ["/admin/assignaImdb", { method: "POST", body: "{}" }],
]) {
    prova(`${opts.method || "GET"} ${ruta} sense token → 403 i el mapa intacte`, async () => {
        const x = xarxaFalsa();
        const kv = await mapaResolt(x);
        const abans = kv.dades.get("mapa_v1");
        const iso = nouIsolate(x);
        const res = await crida(iso, x, entorn(kv), ruta, opts);
        assert.equal(res.status, 403);
        assert.equal(kv.dades.get("mapa_v1"), abans);
    });
}

prova("Token incorrecte → 403", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    const res = await crida(iso, x, entorn(kvFals()), "/buidar?token=dolent");
    assert.equal(res.status, 403);
});

prova("Sense ADMIN_TOKEN configurat → 403 amb instruccions, encara que s'enviï un token", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    const res = await crida(iso, x, entorn(kvFals(), { admin: null }), "/buidar?token=qualsevol");
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /wrangler secret put ADMIN_TOKEN/);
});

prova("/buidar amb token correcte (query) sí que esborra", async () => {
    const x = xarxaFalsa();
    const kv = await mapaResolt(x);
    const iso = nouIsolate(x);
    const res = await crida(iso, x, entorn(kv), `/buidar?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(kv.dades.get("mapa_v1"), undefined);
});

prova("/admin/dades amb capçalera X-Admin-Token → 200", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    const res = await crida(iso, x, entorn(kvFals()), "/admin/dades", { headers: { "X-Admin-Token": TOKEN } });
    assert.equal(res.status, 200);
});

prova("La pàgina /admin envia el token a totes les seves crides", async () => {
    const x = xarxaFalsa();
    const iso = nouIsolate(x);
    const html = await (await crida(iso, x, entorn(kvFals()), `/admin?token=${TOKEN}`)).text();
    assert.match(html, /'X-Admin-Token': TOKEN/);
});

for (const ruta of ["/manifest.json", "/versio", "/poster?t=Akira", "/catalog/series/gdrive_collections.json", "/catalog/movie/gdrive_list.json"]) {
    prova(`${ruta} continua sent públic (Stremio no envia cap token)`, async () => {
        const x = xarxaFalsa();
        const iso = nouIsolate(x);
        preparaRespostes(x, iso.t);
        const res = await crida(iso, x, entorn(kvFals()), ruta);
        assert.equal(res.status, 200);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    const barra = "═".repeat(72);
    console.log(barra + "\nCARÀTULES I CATÀLEGS\n" + barra);
    let total = 0, fallen = 0;
    for (const p of proves) {
        if (p.seccio) { console.log(`\n── ${p.seccio}`); continue; }
        total++;
        try {
            await p.fn();
            console.log(`   ✔ ${p.nom}`);
        } catch (e) {
            fallen++;
            console.log(`   ✘ ${p.nom}\n       ${String(e.message).split("\n").join("\n       ")}`);
        }
    }
    console.log("\n" + barra);
    console.log(fallen ? `${fallen} de ${total} FALLEN` : `TOTES LES ${total} PROVES PASSEN`);
    console.log(barra);
    process.exit(fallen ? 1 : 0);
})();
