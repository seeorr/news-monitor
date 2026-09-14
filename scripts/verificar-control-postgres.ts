/** PostgreSQL real local (WASM), sin .env, red, migraciones remotas o Telegram. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { splitStatements } from "../src/lib/sql.ts";
import { neonControlStore } from "../src/db/control.ts";
import { recentBriefEvents } from "../src/db/brief.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import type { NewsDecision } from "../src/pipeline/news-policy.ts";
const {PGlite}=await import(pathToFileURL(resolve(".cache/pglite/package/dist/index.js")).href);
const db=new PGlite();
const sql:Ejecutor=async(parts,...values)=>(await db.query(parts.map((p,i)=>i<values.length?`${p}$${i+1}`:p).join(""),values)).rows;
const checks:string[]=[];
try {
  for(const file of ["20260910_capture_queue.sql","20260910_news_control.sql","20260910_news_control.sql"])
    for(const statement of splitStatements(await readFile(`neon/migrations/${file}`,"utf8")))await db.query(statement);
  checks.push("migraciones_aditivas_idempotentes");
  const c=neonControlStore("local-only",sql), now="2026-09-10T10:00:00.000Z";
  const requests=await Promise.all(Array.from({length:12},(_,i)=>c.reserve({id:`r${i}`,resource:"brief",units:1,now,hourLimit:3,dayLimit:5})));
  assert.equal(requests.filter(r=>r.allowed).length,3); checks.push("cuota_atomica_3_de_12_postgres_monoconexion");
  assert.equal((await c.reserve({id:"r0",resource:"brief",units:1,now,hourLimit:3,dayLimit:5})).allowed,true);
  assert.equal((await c.reserve({id:"independent",resource:"important",units:1,now,dayLimit:1})).allowed,true);
  assert.equal((await c.reserve({id:"ai",resource:"ai",units:1,now,dayLimit:1})).allowed,true);
  assert.equal((await c.reserve({id:"ai-more",resource:"ai",units:1,now,dayLimit:1})).reason,"day_limit");
  checks.push("idempotencia_y_presupuestos_independientes");
  assert.equal((await c.reserve({id:"next-hour",resource:"brief",units:2,now:"2026-09-10T11:01:00Z",hourLimit:3,dayLimit:5})).allowed,true);
  assert.equal((await c.reserve({id:"daily-full",resource:"brief",units:1,now:"2026-09-10T13:00:00Z",dayLimit:5})).reason,"day_limit");
  assert.equal((await c.reserve({id:"tomorrow",resource:"brief",units:1,now:"2026-09-11T00:00:00Z",dayLimit:5})).allowed,true);
  checks.push("ventanas_horaria_y_diaria_utc");
  assert.equal((await c.stats(now)).find(r=>r.resource==="ai")!.costUsd,null);
  await c.recordAi("ai",{provider:"test",model:"existing-test",promptVersion:"test-v1",stage:"scoring",inputTokens:100,outputTokens:20,attempt:1,costUsd:0.0002,result:"success"});
  assert.equal((await c.stats(now)).find(r=>r.resource==="ai")!.costUsd,0.0002); checks.push("tokens_y_coste_desconocido_distinto_de_cero");
  const decision={policyVersion:"test",assignedAt:now,expiresAt:"2026-09-12T10:00:00Z",level:"digest",eligible:{capture:true,process:true,dashboard:true,telegramBrief:false,morningBrief:true,importantAlert:false},reasons:["test"],relevance:{admit:true,factuality:"fact",evidence:"sufficient",topic:"macro",factType:"macro",watchlistRelation:"none",reasons:[],entities:[]}} as NewsDecision;
  await c.putDecision("kept",decision);
  assert.equal((await neonControlStore("reopened",sql).getDecision("kept"))!.level,"digest"); checks.push("decision_reabierta_independiente_de_entrega");
  for (const statement of splitStatements(`create table events(id text primary key,source text,source_url text,kind text,title text,one_liner text,observed_at text,first_seen_at timestamptz,stale boolean,importance_score int);
    create table alerts(event_id text,importance_score int);
    create table alert_deliveries(event_id text primary key,state text);`)) await db.query(statement);
  for(const id of ["kept","sent","uncertain","excluded","legacy"]){
    await db.query("insert into events values ($1,'rss','https://example.test','news','test','test','2026-09-10',$2,false,6)",[id,now]);
    if(id!=="legacy")await c.putDecision(id,{...decision,eligible:{...decision.eligible,morningBrief:id!=="excluded"}});
  }
  await db.query("insert into alert_deliveries values ('sent','sent'),('uncertain','uncertain')");
  assert.deepEqual((await recentBriefEvents(sql,new Date("2026-09-10T11:00:00Z"))).map(e=>e.id).sort(),["kept","legacy"]);
  checks.push("resumen_excluye_destinos_no_elegibles_enviados_e_inciertos");
  await c.recordAi("ai",{provider:"groq",model:"test",promptVersion:"test-v1",stage:"scoring",inputTokens:null,outputTokens:null,attempt:1,costUsd:null,result:"failed",retryAt:"2026-09-10T11:00:00.000Z"});
  assert.equal(await neonControlStore("reopened",sql).providerRetryAt!("groq",now),"2026-09-10T11:00:00.000Z");
  assert.equal(await c.providerRetryAt!("openrouter",now),null);
  assert.equal(await c.providerRetryAt!("groq","2026-09-10T11:00:00.000Z"),null);
  assert.equal((await c.stats(now)).find(r=>r.resource==="ai")!.calls,1);
  checks.push("cooldown_durable_por_proveedor_expira_sin_nuevas_reservas");
  await mkdir(".cache",{recursive:true});
  await writeFile(".cache/control-postgres-verification.json",JSON.stringify({at:new Date().toISOString(),checks,limitations:"PGlite monoconexión; falta competición entre sesiones reales y despliegue en Neon."},null,2));
  console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{await db.close();}
