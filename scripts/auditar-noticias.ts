/** Solo lectura de decisiones y consumo. No captura, reclama, puntúa o envía. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { neon } from "@neondatabase/serverless";
import { neonControlStore } from "../src/db/control.ts";
import { fileControlStore } from "../src/pipeline/control.ts";
async function main(){
  loadDotEnv(); const c=loadConfig(),now=new Date().toISOString();
  const levels=["important","brief","digest","dashboard","none"];
  let counts:{level:string;count:number}[]=[];
  if(c.databaseUrl){
    const sql=neon(c.databaseUrl);
    counts=await sql`select level,count(*)::integer as count from news_decisions group by level` as typeof counts;
  }else{
    try{
      const state=JSON.parse(await readFile(join(c.stateDir,"news-control.json"),"utf8"));
      counts=levels.map(level=>({level,count:Object.values(state.decisions).filter((d:any)=>d.level===level).length}));
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  const control=c.databaseUrl?neonControlStore(c.databaseUrl):fileControlStore(c.stateDir);
  console.log(JSON.stringify({at:now,scope:"Solo agregados, día UTC; reservas son intentos, no acuses de envío.",
    decisions:levels.map(level=>({level,count:counts.find(r=>r.level===level)?.count??0})),usage:await control.stats(now)},null,2));
}
main().catch(()=>{console.error("NEWS_AUDIT_FAILED: revisar esquema y acceso; no se ha modificado estado.");process.exitCode=1;});
