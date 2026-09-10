/** Evaluación local reproducible. No lee .env ni llama a modelos o Telegram. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { applyRules as beforeRules, mereceAlerta } from "../test/fixtures/baseline-interest-20260910/rules.ts";
import { agrupar as beforeGroups } from "../test/fixtures/baseline-interest-20260910/agrupar.ts";
import { applyRules } from "../src/pipeline/rules.ts";
import { agrupar } from "../src/pipeline/agrupar.ts";
import { decideNews } from "../src/pipeline/news-policy.ts";
import { recientes } from "../src/pipeline/collect.ts";
import { formatInteresting, formatImportant } from "../src/notify/news-formats.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";
type Label = "important" | "brief" | "digest" | "none";
type Case = { id:string; split:string; title:string; score:number; label:Label; official?:boolean; materialWatchlist?:boolean; userLabel:null };
const path = "test/fixtures/news-evaluation.json", raw = await readFile(path, "utf8");
const dataset = JSON.parse(raw) as { cases:Case[]; watchlist:{ticker:string;nombre:string}[]; method:string };
const now = "2026-09-10T10:00:00.000Z";
const makeEvent = (c:Case):NormalizedEvent => ({ id:c.id, source:"rss", kind:"news", source_url:`https://example.test/${c.id}`, title:c.title,
  summary: `Comunicado sintético de evaluación: ${c.title}. Este texto pertenece a una prueba, no a una noticia real.`,
  official:c.official??false, retrieved_at:now, observed_at:now, series_id:"synthetic", country:null, actual:null, previous:null, consensus:null, unit:null, surprises:[], stale:false });
const rows = dataset.cases.map(c => {
  const event = makeEvent(c), scoring = { importance_score:c.score,market_impact_score:c.score,sentiment:"neutral" as const,needs_alert:c.score>=6,one_liner:c.title.slice(0,200) };
  const old = beforeRules(event,{watchlist:dataset.watchlist}), current = applyRules(event,{watchlist:dataset.watchlist});
  const legacyAlert = old.pass && mereceAlerta(event, scoring, 7);
  const before:Label = legacyAlert ? c.score>=7?"important":"brief" : old.pass ? "digest" : "none";
  const decision = decideNews(event, scoring, {now,watchlist:dataset.watchlist});
  const after = decision.level === "dashboard" ? "digest" : decision.level;
  return {...c,synthetic:true,labelOrigin:"agent_proposed",before,after,
    stages:{ capture:"fixture_available_not_live",beforeRules:old,currentRules:current,
      queue:current.pass?"eligible_not_lost_by_cap":"discarded_rules", scoring:"simulated_common_input",
      telegram:"not_sent_simulation",morning:decision.eligible.morningBrief?"eligible_before_top5_and_delivery_exclusion":"policy_excluded" },
    reasons:decision.reasons};
});
function metrics(subset:typeof rows, version:"before"|"after") {
  const tier = (label:Label) => {
    const tp=subset.filter(r=>r[version]===label&&r.label===label).length,
      fp=subset.filter(r=>r[version]===label&&r.label!==label).length,
      fn=subset.filter(r=>r[version]!==label&&r.label===label).length;
    return {tp,fp,fn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null};
  };
  const importantNoise=subset.filter(r=>r[version]==="important"&&r.label==="none").length;
  const missedMaterial=subset.filter(r=>r.materialWatchlist&&r[version]!=="important").length;
  return {count:subset.length,brief:tier("brief"),important:tier("important"),
    usefulReached:subset.filter(r=>r.label!=="none"&&r[version]!=="none").length,
    usefulOmitted:subset.filter(r=>r.label!=="none"&&r[version]==="none").length,
    noiseAdmitted:subset.filter(r=>r.label==="none"&&r[version]!=="none").length,
    weightedPenalty:5*importantNoise+5*missedMaterial+subset.filter(r=>r[version]!==r.label&&!r.materialWatchlist&&!(r[version]==="important"&&r.label==="none")).length,
    scoringCalls:subset.filter(r=>r.stages[version==="before"?"beforeRules":"currentRules"].pass).length,
    proposedBriefItems:subset.filter(r=>r[version]==="brief").length,proposedImportant:subset.filter(r=>r[version]==="important").length,
    digestOrDashboard:subset.filter(r=>r[version]==="digest").length};
}
// Una prueba de agrupación separada evita llamar duplicados a una pérdida de reglas.
const a=makeEvent({...dataset.cases[0]!,id:"duplicate-a",title:"Aster cuts earnings guidance 5 percent"});
const grouping=[a,{...a,id:"duplicate-b"},{...a,id:"update",title:"Aster cuts earnings guidance 50 percent"},{...a,id:"different-entity",title:"Boreal cuts earnings guidance 5 percent"}];
const report={scope:dataset.method, sha256:createHash("sha256").update(raw).digest("hex"),
  limitations:["No mide la precisión real del modelo: usa puntuaciones simuladas iguales en ambos sistemas.","Etiquetas del agente, ninguna etiqueta del usuario.","No capturadas por un feed no se pueden contar a partir de lo que el feed sí contiene.","Reserva no utilizada para ajustar reglas después de esta evaluación."],
  calibration:{before:metrics(rows.filter(r=>r.split==="calibration"),"before"),after:metrics(rows.filter(r=>r.split==="calibration"),"after")},
  holdout:{before:metrics(rows.filter(r=>r.split==="holdout"),"before"),after:metrics(rows.filter(r=>r.split==="holdout"),"after")},
  grouping:{input:4,expectedStories:3,before:beforeGroups(grouping).length,after:agrupar(grouping).length},rows};
await mkdir("docs/evaluacion",{recursive:true});
await writeFile("docs/evaluacion/dos-niveles.json",JSON.stringify(report,null,2)+"\n");
// Fotografía pública opcional. No hay etiquetas de verdad ni puntuaciones inferidas.
const publicPath=process.argv.find(a=>a.startsWith("--public="))?.slice(9);
if(publicPath){
  const snapshot=JSON.parse(await readFile(publicPath,"utf8"));
  const events=(snapshot.feeds??snapshot.results??[]).flatMap((f:{examples?:{event:NormalizedEvent}[]})=>(f.examples??[]).map(e=>e.event)) as NormalizedEvent[];
  const fresh=new Set(recientes(events,{now:new Date(snapshot.retrievedAt),maxAgeHours:72}).map(e=>e.id));
  const results=events.map(e=>({id:e.id,source:e.source,feed:e.series_id,sourceUrl:e.source_url,title:e.title,synthetic:false,userLabel:null,agentLabel:null,
    capture:"observed_public_snapshot",fresh:fresh.has(e.id),before:beforeRules(e),after:applyRules(e),score:null,telegram:"not_evaluated_without_scoring"}));
  await writeFile("docs/evaluacion/muestra-publica.json",JSON.stringify({at:snapshot.retrievedAt,description:"Muestra pública de diagnóstico; no es ground truth ni volumen diario.",count:results.length,
    fresh:results.filter(r=>r.fresh).length,beforeFresh:results.filter(r=>r.fresh&&r.before.pass).length,afterFresh:results.filter(r=>r.fresh&&r.after.pass).length,rows:results},null,2)+"\n");
}
console.log(JSON.stringify({calibration:report.calibration,holdout:report.holdout,grouping:report.grouping},null,2));

// Ejemplos inventados, producidos por los mismos formateadores. Cero transporte.
const briefEvent={...makeEvent({...dataset.cases[0]!,id:"contrato-ficticio",title:"Orion signs copper supply contract"}),
  summary:"Orion confirma un contrato de suministro de cobre para su planta industrial. El comunicado no indica importe ni duración."};
const briefScore={importance_score:5,market_impact_score:5,sentiment:"neutral" as const,needs_alert:false,
  one_liner:"Orion firma un contrato de suministro de cobre para su planta industrial. La fuente confirma el acuerdo, pero no publica su importe ni la duración."};
const importantEvent={...makeEvent({...dataset.cases[0]!,id:"produccion-ficticia",title:"Altair suspends copper production at its northern mine"}),
  summary:"Altair confirma la suspensión de producción de cobre en su mina del norte tras una avería. No indica fecha de reinicio ni cuantifica la producción afectada."};
const importantScore={...briefScore,importance_score:8,market_impact_score:8,needs_alert:true,
  one_liner:"Altair suspende la producción de cobre en su mina del norte por una avería. No hay fecha confirmada de reinicio."};
const importantAnalysis={why_it_matters:"La interrupción podría reducir el suministro disponible para los compradores de esa mina. Su efecto en el mercado dependería de la duración del cierre y de la posibilidad de sustituir esa oferta; esos datos no constan en el comunicado.",
  catalysts:[],affected_assets:[],risks:["La fuente no cuantifica la producción afectada. Una reparación rápida o el uso de inventarios podrían limitar el efecto; no se ha confirmado ninguna de esas circunstancias."],
  what_to_watch:["Vigilar el siguiente parte del operador: diagnóstico de la avería, calendario de reparación y capacidad que pueda recuperar. Una fecha concreta de reinicio cambiaría la valoración de la interrupción."]};
const short=formatInteresting(briefEvent,briefScore),long=formatImportant(importantEvent,importantScore,importantAnalysis);
await writeFile("docs/evaluacion/ejemplos-telegram.md",`# Ejemplos ficticios de Telegram\n\nGenerados localmente por los formateadores del programa. No son noticias reales ni se han enviado.\n\n## Aviso breve (${short.length} caracteres)\n\n${short}\n\n## Alerta importante (${long.length} caracteres)\n\n${long}\n\nLa extensión depende de la evidencia. No se rellena un mensaje escaso para alcanzar un mínimo.\n`);
