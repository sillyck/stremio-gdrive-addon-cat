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

console.log("\n"+"═".repeat(72));
console.log(fall===0 ? `TOTES LES ${total} PROVES PASSEN` : `${fall} de ${total} PROVES FALLEN`);
process.exit(fall?1:0);
