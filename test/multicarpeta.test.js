// Una mateixa sèrie pot tenir MÉS D'UNA carpeta al Drive (versions o rips
// diferents), sovint amb convencions de nom diferents. S'han de recórrer
// totes i ajuntar-ne els resultats.
//
// Regressió: abans el bucle s'aturava a la primera carpeta amb resultats i,
// a més, la memòria en calent només en desava una. Conseqüència: les
// versions de la segona carpeta no sortien mai i els episodis que només hi
// eren allà es donaven per inexistents.
const vm = require("vm");
const path = require("path");
let src = require("fs")
  .readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8")
  .replace(/^export default[\s\S]*$/m, "");
src += "\nglobalThis.__t={getStreams,CREDENTIALS,IMDB_TO_GDRIVE,TITLES_CACHE," +
       "SEASON_STRUCTURE_CACHE,reiniciaPressupost,setMapa:(m)=>{MAPA=m;INDEX_INVERS=null;}};";

const CARPETES = {
  F_A: [
    { id: "a1", name: "Inazuma Eleven T1xC01.mkv", mimeType: "video/x-matroska", size: "1000" },
    { id: "a2", name: "Inazuma Eleven T1xC69.mkv", mimeType: "video/x-matroska", size: "1000" },
  ],
  F_B: [
    { id: "b1", name: "Inazuma Eleven - 001 - Comenca.mkv", mimeType: "video/x-matroska", size: "2000" },
    { id: "b2", name: "Inazuma Eleven - 002 - Segon.mkv", mimeType: "video/x-matroska", size: "2000" },
  ],
};

// Noms REALS de les carpetes (abans no es simulaven: qualsevol GET directe
// d'un fitxer/carpeta requeia al mateix bloc de cerca i tornava {files:[]}
// en lloc de {id,name,...}, així que ordenaCarpetesPerAfinitat mai trobava
// el nom i totes les carpetes quedaven amb afinitat 1 — el test no exercia
// de debò el cas real de "dues carpetes amb convencions diferents".
const NOMS_CARPETA = {
  F_A: "Inazuma Eleven T1xC",
  F_B: "Inazuma Eleven (2008)",
};

let logs = [];
const ctx = {
  console: { log: (o) => logs.push(o), error: (o) => logs.push(o) },
  URL, URLSearchParams, Request, Response, setTimeout, TextEncoder,
  fetch: async (u) => {
    const s = String(u);
    if (s.includes("oauth2")) return { ok: true, json: async () => ({ access_token: "t" }) };
    if (s.includes("googleapis")) {
      const url = new URL(s);
      const q = url.searchParams.get("q") || "";
      // GET directe d'un fitxer/carpeta concret (.../files/{id}, sense 'q'),
      // que és el que fa fetchFile() per llegir el nom real d'una carpeta.
      const midDirecte = !q && /\/files\/([^/?]+)/.exec(url.pathname);
      if (midDirecte) {
        const id = decodeURIComponent(midDirecte[1]);
        if (NOMS_CARPETA[id]) {
          return {
            ok: true,
            json: async () => ({
              id, name: NOMS_CARPETA[id], mimeType: "application/vnd.google-apps.folder",
            }),
          };
        }
        return { ok: false, status: 404 };
      }
      const fid = (/'([^']+)' in parents/.exec(q) || [])[1];
      let files = CARPETES[fid] || [];
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) files = [];
      return { ok: true, json: async () => ({ files }) };
    }
    return { ok: false, status: 404 };
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
ctx.__t.CREDENTIALS.clientId = "a";
ctx.__t.CREDENTIALS.clientSecret = "b";
ctx.__t.CREDENTIALS.refreshToken = "c";

let fall = 0, total = 0;
const prova = (d, c) => { total++; if (!c) fall++; console.log(`   ${c ? "✔" : "✘"} ${d}`); };

(async () => {
  console.log("═".repeat(72));
  console.log("UNA SÈRIE AMB DUES CARPETES DE CONVENCIONS DIFERENTS");
  console.log("═".repeat(72));

  async function demana(s, e) {
    ctx.__t.reiniciaPressupost(46);
    ctx.__t.IMDB_TO_GDRIVE.clear();
    logs = [];
    ctx.__t.TITLES_CACHE.set("tt_IE", ["Inazuma Eleven"]);
    ctx.__t.SEASON_STRUCTURE_CACHE.set("tt_IE", null);
    ctx.__t.setMapa({ "s:F_A": { imdbId: "tt_IE" }, "s:F_B": { imdbId: "tt_IE" } });
    const r = await ctx.__t.getStreams({
      type: "series", id: `tt_IE:${s}:${e}`, season: s, episode: e,
      metadata: { name: "Inazuma Eleven" },
    });
    const info = logs.find((l) => l && l.message && l.message.startsWith("Streams trobats"));
    return { streams: r, info };
  }

  const a = await demana(1, 1);
  prova("episodi present a les dues carpetes → surten les dues versions",
        a.streams.length === 2 && a.info?.carpetes === 2);

  const b = await demana(1, 69);
  prova("episodi que només és a la primera carpeta → es troba", b.streams.length === 1);

  const c = await demana(1, 2);
  prova("episodi que només és a la segona carpeta → es troba", c.streams.length === 1);

  const d = await demana(1, 500);
  prova("episodi inexistent → cap resultat", d.streams.length === 0);

  console.log("\n" + "═".repeat(72));
  console.log(fall === 0 ? `LES ${total} PROVES PASSEN` : `${fall} de ${total} FALLEN`);
  process.exit(fall ? 1 : 0);
})();
