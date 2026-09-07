const vm=require('vm');
let src=require('fs').readFileSync(require('path').join(__dirname,'..','src','index.js'),'utf8')
  .replace(/^export default[\s\S]*$/m,'');
const ctx={console:{log(){},error(){}},fetch:async()=>({ok:false}),URL,URLSearchParams,Request,Response,setTimeout,TextEncoder,Number,Math,Set,Map,Array,Object,JSON,parseInt,String,RegExp,Date,isNaN};
ctx.globalThis=ctx; vm.createContext(ctx); vm.runInContext(src,ctx);
const {trobaEpisodis,assignaEpisodis,detectaEsquema,titolEpisodiDeNom}=ctx;

const f=(r)=>({file:{id:r.join('/'),name:r[r.length-1]},ruta:r});
const g=(n)=>n.map(x=>f(Array.isArray(x)?x:[x]));
let fall=0, total=0;

function prova(desc, cond){ total++; if(!cond){fall++;} console.log(`   ${cond?'✔':'✘'} ${desc}`); }

function serie(nom, fitxers, estructura, casos, titolSerie){
  console.log(`\n── ${nom}`);
  const {esquema}=detectaEsquema(fitxers);
  console.log(`   esquema detectat: ${esquema}`);

  // 1) La cerca retorna EXACTAMENT el fitxer demanat
  for(const [s,e,frag] of casos){
    const r=trobaEpisodis(fitxers,s,e,estructura);
    const noms=r.matches.map(m=>m.ruta.join('/'));
    if(frag===null){ prova(`S${s}E${e} → cap resultat (correcte)`, noms.length===0); }
    else prova(`S${s}E${e} → ${noms[0]||'RES'}`, noms.length===1 && noms[0].includes(frag));
  }

  // 2) COHERÈNCIA: el que es llista com a episodi N ha de ser el que retorna la cerca
  const llistat=assignaEpisodis(fitxers);
  let coherent=true, revisats=0;
  for(const ep of llistat){
    const r=trobaEpisodis(fitxers,ep.season,ep.episode,estructura);
    if(r.matches.length===0) continue;
    revisats++;
    if(!r.matches.some(m=>m.file.id===ep.file.id)) coherent=false;
  }
  prova(`llistat i cerca coincideixen (${revisats} episodis comprovats)`, coherent && revisats>0);

  // 3) Cap número d'episodi duplicat al llistat
  const claus=llistat.map(e=>`${e.season}:${e.episode}`);
  prova(`sense episodis duplicats al llistat`, new Set(claus).size===claus.length);
}

console.log("═".repeat(72));
console.log("SUITE COMPLETA — codi real de src/index.js");
console.log("═".repeat(72));

serie("Death Note (S01×Enn — el cas de la captura)",
 g(Array.from({length:37},(_,i)=>`Death Note S01×E${String(i+1).padStart(2,'0')}.mkv`)),
 [undefined,37], [[1,1,"E01"],[1,28,"E28"],[1,36,"E36"],[1,99,null]]);

serie("Fanboy & Chum Chum (T1xCnn)",
 g(["T1xC8 Fuga de cervells.mkv","T1xC11 El justificant.mkv","T1xC12 Marsha.mkv",
    "T1xC13 El millor bromista.mkv","T1xC14 Una joguina.mkv","T1xC15 El fresquibus.mkv"]),
 [undefined,26], [[1,11,"T1xC11"],[1,8,"T1xC8"],[1,15,"T1xC15"],[1,9,null]]);

serie("One Piece (NxM, dues temporades)",
 g(["One Piece - 01x01 - Yo soy Luffy.mkv","One Piece - 01x02 - El gran espadachin.mkv",
    "One Piece - 01x03 - Zoro.mkv","One Piece - 02x01 - Nou comencament.mkv",
    "One Piece - 02x02 - La navegant.mkv"]),
 [undefined,3,2], [[1,1,"01x01"],[1,3,"01x03"],[2,1,"02x01"],[2,2,"02x02"]]);

serie("Fullmetal Alchemist B. (FMAB nn v2)",
 g(["FMAB 01 v2.mkv","FMAB 02 v2.mkv","FMAB 03 v2.mkv","FMAB 04.mkv","FMAB 05.mkv"]),
 [undefined,64], [[1,1,"FMAB 01"],[1,4,"FMAB 04"],[1,5,"FMAB 05"],[1,9,null]]);

serie("Bo-Bobo (Bobobo nn by ackman)",
 g(["Bobobo 01 by ackman.mkv","Bobobo 02 by ackman.mkv","Bobobo 03 by ackman.mkv","Bobobo 04 by ackman.mkv"]),
 [undefined,76], [[1,1,"Bobobo 01"],[1,3,"Bobobo 03"]]);

serie("Bobobops (cap número — posicional)",
 g(["Bobobobs Opening.mkv","Bobobobs.mkv","El panta.mkv","L'ermita cosmic.mkv"]),
 [undefined,13], [[1,1,"Opening"],[1,3,"panta"],[1,4,"ermita"]]);

serie("Dragui (Historia de Catalunya — sense números)",
 g(["Historia de Catalunya A.mkv","Historia de Catalunya B.mkv",
    "Historia de Catalunya C.mkv","Historia de Catalunya D.mkv"]),
 null, [[1,1,"A.mkv"],[1,2,"B.mkv"],[1,4,"D.mkv"]]);

serie("Bola de Drac (numeració absoluta, T1=26)",
 g(Array.from({length:60},(_,i)=>`Bola de Drac - ${String(i+1).padStart(3,'0')} - Titol.mkv`)),
 [undefined,26,26,30], [[1,1,"- 001 -"],[1,26,"- 026 -"],[2,1,"- 027 -"],[2,5,"- 031 -"]]);

serie("Carpetes de temporada",
 g([["Temporada 1","capitol 01.mkv"],["Temporada 1","capitol 02.mkv"],
    ["Temporada 2","capitol 01.mkv"],["Temporada 2","capitol 05.mkv"]]),
 [undefined,2,5], [[1,1,"Temporada 1/capitol 01"],[2,5,"Temporada 2/capitol 05"],[2,9,null]]);

console.log("\n── Diverses qualitats del mateix episodi");
const q=g(["Bleach S01E01 [1080p].mkv","Bleach S01E01 [720p cat].mkv","Bleach S01E02 [1080p].mkv"]);
const rq=trobaEpisodis(q,1,1,null);
prova(`S1E1 → 2 qualitats (no 3)`, rq.matches.length===2 && rq.matches.every(m=>m.nomArxiu.includes("S01E01")));

console.log("\n── Regressió: patró que col·lapsa (el bug original)");
const mal=g(["Show S01 Alpha.mkv","Show S01 Beta.mkv","Show S01 Gamma.mkv","Show S01 Delta.mkv"]);
const rm=trobaEpisodis(mal,1,1,null);
prova(`no retorna la sèrie sencera per un sol episodi`, rm.matches.length===1);
prova(`esquema descartat correctament`, detectaEsquema(mal).esquema==="posicional");

console.log("\n── Neteja del títol de l'episodi");
prova(`"S01×E28" no apareix al títol`,
  titolEpisodiDeNom("Death Note S01×E28.mkv",["Death Note"])===null);
prova(`"T1xC11 El justificant" → "El justificant"`,
  titolEpisodiDeNom("T1xC11 El justificant.mkv",["Fanboy"])==="El justificant");

console.log("\n── Sèrie llarga de moltes temporades amb numeració absoluta");
// Cas real vist als logs: peticions tipus tt0131179:30:1 i :34:1.
// Temporades de mides desiguals, fitxers numerats de l'1 al 992.
{
  const eps=[26,29,29,28,29,29,32,30,29,28,31,29,28,30,29,30,29,29,30,28,
             29,30,28,29,30,29,28,30,29,31,30,29,28,30];
  const estructura=[undefined,...eps];
  const n=eps.reduce((a,b)=>a+b,0);
  const fitxers=Array.from({length:n},(_,i)=>f([`Serie - ${String(i+1).padStart(4,'0')} - Cap.mkv`]));
  let bons=0, massa=0;
  for(let s=1;s<=eps.length;s++) for(let e=1;e<=eps[s-1];e++){
    let abs=0; for(let i=1;i<s;i++) abs+=eps[i-1]; abs+=e;
    const r=trobaEpisodis(fitxers,s,e,estructura);
    if(r.matches.length>1) massa++;
    if(r.matches.length===1 && r.matches[0].nomArxiu.includes(`- ${String(abs).padStart(4,'0')} -`)) bons++;
  }
  prova(`els ${n} episodis de ${eps.length} temporades es resolen bé`, bons===n);
  prova(`cap petició retorna episodis de sobra`, massa===0);
}

console.log("\n── Exclusió de carpetes d'extres (cas real d'El Detectiu Conan)");
{
  const esExtra = ctx.esCarpetaDExtres;
  const omet = ["Extres","Pelis","OVAs","OPs EDs","Music","Singles","Series OST",
                "Movies OST","Extras","Especials","NCOP","Trailers","OST"];
  const recorre = ["Multi-Audio+Subs","Temporada 1","Season 2","T3","01","Episodis",
                   "Capitols","Saga Freezer","Arc 1","Opening Act","Edward i Alphonse"];
  prova(`${omet.length} carpetes d'extres s'ometen`, omet.every(esExtra));
  prova(`${recorre.length} carpetes d'episodis es recorren`, recorre.every((n) => !esExtra(n)));
}

console.log("\n── Fitxers que no són episodis (openings, OVAs, pel·lícules)");
{
  const noEp = ctx.esFitxerNoEpisodi;
  const fora = ["OP1.mkv","NCOP.mkv","NCED2.mkv","ED 03.mkv","Opening 2.mkv","Ending 1.mkv",
                "OVA 01 - El tresor perdut.mkv","OVA1.mkv","Pel·lícula 03.mkv","Movie 1.mkv",
                "Trailer.mkv","PV 2.mp4","Obertura.mkv"];
  // Casos delicats: episodis reals amb paraules que semblen marques d'extra
  const dins = ["Death Note S01×E28.mkv","T1xC11 El justificant.mkv",
                "One Piece - 01x01 - Yo soy Luffy.mkv","Bola de Drac - 031 - El Gran Torneig.mkv",
                "FMAB 01 v2.mkv","Bobobo 01 by ackman.mkv",
                "Capitol 12 - L obertura del torneig.mkv","S02E05 - Opening Act.mkv",
                "045 - La pel·lícula que van rodar.mkv"];
  prova(`${fora.length} extres s'ometen`, fora.every(noEp));
  prova(`${dins.length} episodis reals es mantenen`, dins.every((n) => !noEp(n)));
}

console.log("\n── Filtre d'extres amb les carpetes reals de Bola de Drac");
{
  const ex = ctx.esCarpetaDExtres;
  const fora = ["OSTs","Subtitols per Versio Albert Wesker","Scans","Extres",
                "Dragonball Z Complete Song Collection Box [FLAC]",
                "Dragon Ball - Music Collection [FLAC]"];
  const dins = ["Bola de Drac Z [cat jap] [Albert Wesker]","Multi-Audio+Subs",
                "DRAGONBALL Zenkyoku Shu","Temporada 1"];
  prova(`${fora.length} carpetes d'extres reals s'ometen`, fora.every(ex));
  prova(`${dins.length} carpetes d'episodis reals es recorren`, dins.every((n) => !ex(n)));
}

console.log("\n── Temporades del Drive desalineades amb les de TMDB (cas Inazuma Eleven)");
{
  // 141 fitxers numerats T1..T3 al Drive; TMDB en compta 4 temporades.
  const fs = [];
  for (let c = 1; c <= 50; c++) fs.push(f([`Serie T1xC${String(c).padStart(2,"0")}.mkv`]));
  for (let c = 1; c <= 50; c++) fs.push(f([`Serie T2xC${String(c).padStart(2,"0")}.mkv`]));
  for (let c = 1; c <= 41; c++) fs.push(f([`Serie T3xC${String(c).padStart(2,"0")}.mkv`]));
  const est = [undefined, 40, 40, 40, 21];
  const un = (s, e) => {
    const r = trobaEpisodis(fs, s, e, est);
    return r.matches.length === 1 ? r.matches[0].nomArxiu : null;
  };
  prova("la coincidència exacta mana quan existeix", un(2,45)?.includes("T2xC45"));
  prova("S4E1 (temporada inexistent al Drive) → absolut 121", un(4,1)?.includes("T3xC21"));
  prova("S4E7 → absolut 127", un(4,7)?.includes("T3xC27"));
  prova("S4E21 → absolut 141, l'últim", un(4,21)?.includes("T3xC41"));
  prova("fora de rang no retorna res", un(4,22) === null && un(9,1) === null);

  // Si al Drive falten episodis, la reserva per posició donaria un episodi
  // EQUIVOCAT. En aquest cas val més no retornar res.
  const estIncompleta = [undefined, 60, 60, 60, 70];   // TMDB compta 250, al Drive n'hi ha 141
  const unInc = (s, e) => {
    const r = trobaEpisodis(fs, s, e, estIncompleta);
    return r.matches.length === 1 ? r.matches[0].nomArxiu : null;
  };
  prova("col·lecció incompleta: no inventa cap episodi", unInc(4,1) === null);
  prova("col·lecció incompleta: el que sí existeix segueix sortint", unInc(2,45)?.includes("T2xC45"));
}

console.log("\n── Sèries germanes dins d'un contenidor de franquícia");
{
  const norm = ctx.normalitzaTitol;
  const germana = (carpeta, titols) => ctx.esSerieGermana(carpeta, titols.map(norm));
  const casos = [
    // [carpeta, títols buscats, ha de ser germana?]
    ["Bola de Drac Z [cat jap] [Albert Wesker]", ["Dragon Ball","Bola de Drac"], true],
    ["Bola de Drac GT [cat jap]", ["Bola de Drac"], true],
    ["Bola de Drac Super", ["Bola de Drac"], true],
    ["Bola de Drac Kai", ["Bola de Drac"], true],
    ["Inazuma Eleven GO", ["Inazuma Eleven"], true],
    ["Inazuma Eleven GO Chrono Stones", ["Inazuma Eleven GO"], true],
    ["Naruto Shippuden", ["Naruto"], true],
    // Aquestes són parts de la MATEIXA sèrie i s'han de recórrer
    ["Bola de Drac [cat jap] [Albert Wesker]", ["Bola de Drac"], false],
    ["Bola de Drac Saga Freezer", ["Bola de Drac"], false],
    ["Bola de Drac - Temporada 1", ["Bola de Drac"], false],
    ["Bola de Drac Part 2", ["Bola de Drac"], false],
    ["Bola de Drac 2", ["Bola de Drac"], false],
    ["One Piece [1-500]", ["One Piece"], false],
    ["One Piece [501-1000]", ["One Piece"], false],
    ["El detectiu Conan [WebDl]", ["El detectiu Conan"], false],
    ["Naruto", ["Naruto"], false],
    ["Temporada 1", ["Bola de Drac"], false],
    ["Bleach", ["Bola de Drac"], false],
  ];
  const fallats = casos.filter(([c, t, esp]) => germana(c, t) !== esp);
  prova(`${casos.length} carpetes classificades bé com a germana o part`, fallats.length === 0);
  if (fallats.length) console.log("      fallats:", fallats.map((x) => x[0]).join(", "));
}

console.log("\n── Tria de subcarpeta dins un contenidor de franquícia");
{
  const subs = [
    { id:"S_DB",  name:"Bola de Drac [cat jap] [Albert Wesker]" },
    { id:"S_Z",   name:"Bola de Drac Z [cat jap] [Albert Wesker]" },
    { id:"S_GT",  name:"Bola de Drac GT [cat jap] [Albert Wesker]" },
    { id:"S_KAI", name:"Bola de Drac Z Kai - Els Capítols Finals [cat]" },
    { id:"S_OST", name:"OSTs" },
  ];
  // Reprodueix la tria sense tocar la xarxa
  const tria = (titols) => {
    const tn = titols.map(ctx.normalitzaTitol);
    const cands = [];
    for (const sub of subs) {
      if (ctx.esCarpetaDExtres(sub.name)) continue;
      const nets = ctx.cleanTitleForSearch(sub.name);
      const variants = new Set([...nets.queries, sub.name]
        .filter((q) => q !== nets.curt).map(ctx.normalitzaTitol).filter(Boolean));
      let millor = null;
      for (const t of tn) if (variants.has(t) && (!millor || t.length > millor.length)) millor = t;
      if (millor) cands.push({ sub, titol: millor });
    }
    if (!cands.length) return "ROOT";
    const max = Math.max(...cands.map((c) => c.titol.length));
    const m = cands.filter((c) => c.titol.length === max);
    return m.length === 1 ? m[0].sub.id : "ROOT";
  };
  const casos = [
    [["Dragon Ball","Bola de Drac"], "S_DB"],
    [["Dragon Ball Z","Bola de Drac Z"], "S_Z"],
    [["Dragon Ball Z","Bola de Drac Z","Bola de Drac"], "S_Z"],
    [["Dragon Ball GT","Bola de Drac GT"], "S_GT"],
    [["Dragon Ball Z Kai","Bola de Drac Z Kai - Els Capítols Finals"], "S_KAI"],
    [["Dragon Ball Z Kai","Bola de Drac Z Kai"], "S_KAI"],
    [["Bleach"], "ROOT"],
  ];
  const mal = casos.filter(([t, esp]) => tria(t) !== esp);
  prova(`${casos.length} sèries de la franquícia van a la seva subcarpeta`, mal.length === 0);
  if (mal.length) console.log("      fallats:", JSON.stringify(mal.map((x) => x[0])));
}

console.log("\n── Viquipèdia: només s'accepten articles amb el títol correcte");
{
  // Casos reals dels logs, on la cerca de text complet retornava disbarats.
  const norm = ctx.normalitzaTitol;
  const accepta = (consulta, titolArticle) => {
    const objectiu = norm(consulta);
    const t = norm(String(titolArticle).replace(/\s*\([^)]*\)\s*$/, ""));
    if (!t || !objectiu) return false;
    if (t === objectiu) return true;
    return ["serie","pel·licula","pelicula","anime","manga","serie de televisio","film"]
      .some((sufix) => t === `${objectiu} ${sufix}`);
  };
  const fora = [
    ["Espies de veritat", "2001: una odissea de l'espai"],
    ["La Betty atòmica", "Hulk (personatge)"],
    ["Mandarina & Cow", "Ara em veus 2"],
    ["Combat Xiaolin", "La llegenda del puny"],
    ["Memories", "Memòries d'Àfrica"],
    ["Regnat de Sang", "Love Lies Bleeding"],
    ["Hiroshima 1983", "Hiroshima mon amour"],
    ["Doraemon 2005", "Doraemon Comes Back"],
  ];
  const dins = [
    ["Caçadors de dracs", "Caçadors de dracs"],
    ["Viatges Pokémon", "Viatges Pokémon"],
    ["Regnat de Sang", "Regnat de Sang (sèrie de televisió)"],
    ["Bola de Drac", "Bola de Drac (sèrie)"],
  ];
  prova(`${fora.length} coincidències falses es rebutgen`, fora.every(([c,t]) => !accepta(c,t)));
  prova(`${dins.length} coincidències bones s'accepten`, dins.every(([c,t]) => accepta(c,t)));
}

console.log("\n── Numeració plana amb temporades desconegudes per TMDB (Bola de Drac)");
{
  // Cas real: 153 fitxers numerats de l'1 al 153; TMDB té la sèrie com una
  // sola temporada, però Stremio (via TVDB) en demana 9. L'estructura de
  // Cinemeta permet convertir temporada/episodi a número absolut.
  const talls = [28, 29, 23, 23, 10, 17, 14, 4, 5];   // suma 153
  const est = [undefined, ...talls];
  const fs153 = Array.from({ length: 153 }, (_, i) =>
    f([`Serie - ${String(i + 1).padStart(3, "0")} - Cap.mkv`]));
  const casos = [[1,1],[1,13],[2,1],[4,1],[9,5]];
  const mal = casos.filter(([s, e]) => {
    let abs = 0; for (let i = 1; i < s; i++) abs += talls[i - 1]; abs += e;
    const r = trobaEpisodis(fs153, s, e, est);
    return !(r.matches.length === 1 &&
             r.matches[0].nomArxiu.includes(`- ${String(abs).padStart(3, "0")} -`));
  });
  prova(`${casos.length} peticions de temporades altes es converteixen a absolut`, mal.length === 0);
  if (mal.length) console.log("      fallats:", JSON.stringify(mal));
}

console.log("\n── Carpetes de temporada en català i castellà");
{
  const t = ctx.temporadaDeCarpeta;
  const casos = [
    [["Llibre 1 - Aigua", "ep.mkv"], 1],   // Avatar, real dels logs
    [["Llibre 3 - Foc", "ep.mkv"], 3],
    [["Libro 2", "ep.mkv"], 2],
    [["Book 3", "ep.mkv"], 3],
    [["Temporada 4", "ep.mkv"], 4],
    [["T2", "ep.mkv"], 2],
    [["03", "ep.mkv"], 3],
    [["Bola de Drac", "ep.mkv"], null],
    [["Multi-Audio+Subs", "ep.mkv"], null],
  ];
  const mal = casos.filter(([r, esp]) => t(r) !== esp);
  prova(`${casos.length} noms de carpeta de temporada es llegeixen bé`, mal.length === 0);
}

console.log("\n── Pel·lícules i OVAs dins les carpetes de sèries");
{
  const esPelis = ctx.esCarpetaDePelis;
  const si = ["Pelis", "Pel·lícules", "Movies", "Films", "OVAs", "OVA", "Especials"];
  const no = ["Music", "OPs EDs", "Extres", "T1", "Multi-Audio+Subs", "OSTs"];
  prova(`${si.length} carpetes de pel·lícules es reconeixen`, si.every(esPelis));
  prova(`${no.length} carpetes que no ho són es descarten`, no.every((n) => !esPelis(n)));
  // Els episodis normals no s'han de veure afectats pel canvi
  prova("les carpetes de pel·lícules segueixen fora del recorregut d'episodis",
        ["Pelis", "OVAs", "Especials"].every(ctx.esCarpetaDExtres));
}

console.log("\n"+"═".repeat(72));
console.log(fall===0 ? `TOTES LES ${total} PROVES PASSEN` : `${fall} de ${total} PROVES FALLEN`);
process.exit(fall?1:0);
