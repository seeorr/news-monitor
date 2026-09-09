/**
 * `/settings` — la configuración vigente, y qué se puede tocar desde aquí.
 *
 * Solo la watchlist escribe, y vive en su propia página. Los umbrales y los
 * feeds se leen de variables de entorno en `loadConfig()`, y en producción esas
 * variables son secretos y variables del repositorio que el workflow inyecta al
 * arrancar el job: no comparten proceso, ni máquina, ni ciclo de vida con este
 * servidor. Un formulario aquí no podría cambiarlas (hueco G7).
 *
 * Así que se enseñan **en modo lectura**, diciendo dónde se cambian. Es útil
 * —hoy no hay ningún otro sitio donde consultarlas— y no miente. Un interruptor
 * que no apaga nada sí mentiría.
 */
import Link from "next/link";
import { Bloque, Cabecera } from "../_componentes/cabecera.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { cargar } from "../_lib/cargar.ts";
import { SOURCE_LABEL, es, fechaYHora, haceCuanto } from "../_lib/formato.ts";
import { actividadPorFuente, recuento } from "../../src/db/lectura.ts";
import { describeMissing, loadConfig, missingVars } from "../../src/config.ts";
import { FEEDS } from "../../src/sources/rss.ts";

export const dynamic = "force-dynamic";

export default async function Ajustes() {
  const ahora = new Date();
  const config = loadConfig();
  const faltan = missingVars(config);

  const sistema = await cargar(async (sql) => ({
    total: await recuento(sql),
    fuentes: await actividadPorFuente(sql, 24),
  }));

  return (
    <>
      <Cabecera
        titulo="Ajustes"
        descripcion="Lo que el ciclo tiene configurado ahora mismo. Solo la watchlist se edita desde aquí."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <Bloque titulo="El sistema" nota="indicio de vida, no registro de ejecuciones">
            {!sistema.ok ? (
              <SinDatos motivo={sistema.motivo} />
            ) : (
              <div className="rounded-tarjeta border border-linea bg-card px-4 py-3.5">
                <dl className="grid grid-cols-2 gap-y-1.5 text-secundario">
                  <dt className="text-txt-3">Eventos registrados</dt>
                  <dd className="cifra">{sistema.datos.total.eventos}</dd>
                  <dt className="text-txt-3">De ellos, puntuados</dt>
                  <dd className="cifra">{sistema.datos.total.puntuados}</dd>
                  <dt className="text-txt-3">Alertas enviadas</dt>
                  <dd className="cifra">{sistema.datos.total.alertas}</dd>
                  <dt className="text-txt-3">Último evento</dt>
                  <dd className="cifra">
                    {sistema.datos.total.ultimo
                      ? haceCuanto(sistema.datos.total.ultimo, ahora)
                      : "ninguno todavía"}
                  </dd>
                </dl>

                <p className="mt-3 mb-1.5 text-meta text-txt-3">Últimas 24 horas, por fuente</p>
                {sistema.datos.fuentes.length === 0 ? (
                  <p className="text-secundario text-txt-3">
                    Nada en 24 horas. O el cron no está corriendo, o ninguna fuente ha publicado.
                  </p>
                ) : (
                  <ul className="text-secundario">
                    {sistema.datos.fuentes.map((f) => (
                      <li key={f.source} className="flex justify-between border-b border-linea py-1 last:border-b-0">
                        <span>{SOURCE_LABEL[f.source] ?? f.source}</span>
                        <span className="cifra text-txt-2">
                          {f.eventos} <span className="text-meta text-txt-3">{haceCuanto(f.ultimo, ahora)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-3 text-meta text-txt-3">
                  No hay registro de ejecuciones del cron: solo existe en los logs de GitHub
                  Actions. Esto es una prueba de que el ciclo respira, no un historial.
                </p>
              </div>
            )}
          </Bloque>

          <Bloque titulo="Credenciales">
            {faltan.length === 0 ? (
              <p className="rounded-tarjeta border border-success-border bg-success-bg px-4 py-3 text-secundario text-success-text">
                No falta ninguna variable imprescindible.
              </p>
            ) : (
              <pre className="cuerpo-alerta rounded-tarjeta border border-warning-border bg-warning-bg px-4 py-3 text-warning-text">
                {describeMissing(faltan)}
              </pre>
            )}
          </Bloque>
        </div>

        <div>
          <Bloque titulo="Alertas" nota="solo lectura">
            <Tabla
              filas={[
                ["Umbral de alerta", String(config.alertThreshold), "ALERT_THRESHOLD"],
                ["Umbral de análisis profundo", String(config.deepAnalysisThreshold), "DEEP_ANALYSIS_THRESHOLD"],
                ["Techo de scoring por ciclo", String(config.maxScoringPerCycle), "MAX_SCORING_PER_CYCLE"],
                ["Techo de análisis profundos", String(config.maxDeepPerCycle), "MAX_DEEP_PER_CYCLE"],
                ["Antigüedad máxima de un titular", `${config.maxItemAgeHours} h`, "MAX_ITEM_AGE_HOURS"],
                ["Parecido para fundir titulares", es(config.umbralAgrupacion, 2), "GROUP_THRESHOLD"],
                ["Días de agenda", String(config.agendaDias), "AGENDA_DIAS"],
                ["Modelo de scoring", config.modelScoring, "MODEL_SCORING"],
                ["Modelo de análisis", config.modelAnalysis, "MODEL_ANALYSIS"],
              ]}
            />
            <p className="mt-2 text-meta text-txt-3">
              Se cambian en el repositorio: Settings → Secrets and variables → Actions → Variables.
              Vacías, mandan los valores por defecto del código.
            </p>
          </Bloque>

          <Bloque titulo="Fuentes" nota="solo lectura">
            <Tabla
              filas={Object.values(FEEDS).map((f) => [
                f.title,
                config.feeds.length === 0 || config.feeds.includes(f.id) ? "activo" : "apagado",
                f.id,
              ])}
            />
            <p className="mt-2 text-meta text-txt-3">
              Se activan y se apagan con la variable <code>RSS_FEEDS</code>. Vacía, entran todos.
            </p>
          </Bloque>

          <Bloque titulo="Watchlist">
            <p className="text-secundario text-txt-2">
              Es lo único editable, y tiene su propia página porque es dato personal y decide a
              quién se le miran los documentos y a quién el precio.
            </p>
            <Link
              href="/watchlist"
              className="mt-2 inline-block text-secundario text-accent-text underline underline-offset-2"
            >
              Ir a la watchlist
            </Link>
          </Bloque>
        </div>
      </div>

      <p className="mt-6 text-meta text-txt-3">
        Consultado a las {fechaYHora(ahora)}.
      </p>
    </>
  );
}

function Tabla({ filas }: { filas: Array<readonly [string, string, string]> }) {
  return (
    <div className="overflow-x-auto rounded-tarjeta border border-linea bg-card">
      <table className="w-full text-secundario">
        <tbody>
          {filas.map(([etiqueta, valor, variable]) => (
            <tr key={variable} className="border-b border-linea last:border-b-0">
              <td className="py-1.5 pl-3.5">{etiqueta}</td>
              <td className="cifra py-1.5 text-right font-medium">{valor}</td>
              <td className="py-1.5 pr-3.5 pl-3 text-right text-meta text-txt-3">
                <code>{variable}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
