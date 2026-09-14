# Reversión de News Monitor

Procedimiento único para volver atrás sin perder datos. Sustituye a las
secciones de reversión repartidas por `activacion-cadencia.md`,
`cadencia-cloudflare.md`, `captura-persistente.md`, `disparador-externo.md`,
`fuentes-cobertura.md` y `llm-gratuitos.md`, que se conservan como historia.

Escrito el 14-09-2026, tras un día con cinco cambios de producción: cupo, LLM,
Worker dos veces y una migración que borró un check. Ninguno tenía un camino
de vuelta probado.

## Principios

1. **Parar antes de revertir.** Primero se cortan disparos y envíos; después se
   cambia código o configuración.
2. **Del nivel más suave al más duro.** Casi todo se resuelve con el nivel 1.
3. **Los datos no se tocan.** Toda migración es aditiva: el código antiguo
   ignora las columnas y tablas nuevas.
4. **Comprobar el efecto, no el comando.** Un `gh variable set` aceptado no
   demuestra que el ciclo siguiente lo haya leído.
5. **Anotar** hora, nivel y motivo en la nota del día del proyecto.

## Lo que no se hace nunca

- Borrar, vaciar o «limpiar» `capture_queue`, `news_usage`, `news_decisions`,
  `alert_deliveries`, `daily_briefs` ni `dashboard_login_attempts`.
- Liberar filas `sending` o `uncertain`, o usar `--force`, para «destrabar» una
  entrega. Un mensaje incierto pudo llegar; reenviarlo es decisión de Alberto.
- Restaurar una copia antigua de la base encima de la actual.
- `git push --force` sobre `main`. Se revierte con `git revert`.
- Cancelar a ciegas un job de Monitor en curso: puede estar enviando.
- Ejecutar `npm run db:migrate` sin que `Comprobaciones` esté en verde en ese
  commit. El 14-09 una migración antigua borró un check al reejecutarse.

## Estado de referencia (14-09-2026)

Lo que hay que recuperar al deshacer una reversión.

| Pieza | Valor |
|---|---|
| `MONITOR_MODE` | `full` |
| `AI_CALLS_PER_DAY` | `350` |
| `MAX_SCORING_PER_CYCLE` / `MAX_DEEP_PER_CYCLE` | `4` / `1` |
| `MAX_ITEM_AGE_HOURS` / `GROUP_THRESHOLD` / `AGENDA_DIAS` | `72` / `0.6` / `7` |
| `RUN_TELEMETRY` | `true` |
| `LLM_PROVIDERS`, `GROQ_MODEL_*`, `OPENROUTER_MODEL` | sin variable: valores por defecto (`groq,openrouter`, 120b, respaldo 20b solo para puntuar) |
| Workflows activos | Agenda, Resumen de mañana, Comprobaciones, Latido, Monitor, Salud, Verificar LLM gratuitos |
| Worker `news-monitor-clock` | versión `d0afa687`, un cron `3,13,23,33,43,53 * * * *`, `STRATEGY=mixed`, `ENABLED=true` |

Leer el estado actual: `gh variable list -R seeorr/news-monitor` y
`gh workflow list -R seeorr/news-monitor --all`. Nombres de secretos, nunca
valores: `gh secret list -R seeorr/news-monitor`.

## Antes y después de cualquier nivel

Solo lectura, desde `codigo/`:

```powershell
npm run audit:health   # estados, cola, cupo y entregas
npm run audit:queue    # cola por fuente y motivo
gh run list -R seeorr/news-monitor --workflow monitor.yml -L 5
```

Guardar la salida del «antes». Después de revertir, los pendientes pueden
crecer, pero **ninguna fila de entrega ni de la cola puede desaparecer**.

**Cuidado con el cupo en local.** `audit:health` compara las reservas reales
con el `AI_CALLS_PER_DAY` del `.env` local, no con el de producción. El 14-09 el
`.env` tenía 180 y producción 350, así que la auditoría local marcó
`budget_exhausted` con 23 intentos todavía libres. Antes de decidir nada por el
cupo, leer el límite real con `gh variable get AI_CALLS_PER_DAY -R seeorr/news-monitor`,
o lanzar la auditoría con ese valor: `$env:AI_CALLS_PER_DAY = "350"; npm run audit:health`.

## Nivel 1 · Pausar modelos y envíos, conservar la captura

**Cuándo:** alertas erróneas, un proveedor LLM que falla, gasto inesperado o
cualquier duda sobre lo que sale por Telegram.

```powershell
gh variable set MONITOR_MODE --body capture-only -R seeorr/news-monitor
```

- **Una sola llave.** El Worker manda `mode: auto`, así que manda la variable de
  GitHub. Lo de «las dos llaves» de `activacion-cadencia.md` ya no aplica.
- Para una ventana **sin ningún mensaje**, pausar también las salidas propias:
  `gh workflow disable agenda.yml` y `gh workflow disable brief.yml`.
- El vigilante ve `processing_paused` y **no avisa**: es una parada querida.

**Comprobar:** el ciclo siguiente registra `CAPTURE_ONLY` y termina sin
`SCORED` ni `ALERT_SENT`. `audit:health` muestra `processing_paused`.

**Deshacer:** `gh variable set MONITOR_MODE --body full`, y
`gh workflow enable` de lo pausado. El ciclo siguiente procesa lo capturado
mientras tanto. Lo que pase de 48 h queda `pending_expired`, sin borrarse.

## Nivel 2 · Reducir o cambiar la IA

**Cuándo:** consumo alto, un modelo que degrada o un proveedor en duda.

| Qué | Orden |
|---|---|
| Menos llamadas al día | `gh variable set AI_CALLS_PER_DAY --body 180` |
| Menos por ciclo | `gh variable set MAX_SCORING_PER_CYCLE --body 2` |
| Sin OpenRouter | `gh variable set LLM_PROVIDERS --body groq` |
| Sin respaldo 20b | `gh variable set GROQ_MODEL_FALLBACK --body none` |

Todas con `-R seeorr/news-monitor`. Ninguna necesita migración.

**Comprobar:** `audit:health` (límite y reservas del día) y el log del ciclo
(`LLM_MODEL_FALLBACK`, `AI_BUDGET_NOTICE`).

**Deshacer:** volver al valor de la tabla de referencia, o
`gh variable delete <NOMBRE>` si allí figura «sin variable».

## Nivel 3 · Parar el reloj de Cloudflare

**Cuándo:** disparos duplicados o fuera de hora, o un Worker que se comporta mal.

- **Normal**, desde `codigo/cloudflare-dispatcher`:
  `npx wrangler deploy --var ENABLED:false`. Puede tardar unos minutos.
- **Urgente, sin esperar:** revocar el token en GitHub → Settings → Developer
  settings → Fine-grained tokens. Un job ya arrancado sigue con su token
  efímero de Actions y termina.
- **Con el reloj parado sigue el respaldo de GitHub**: el `schedule` de
  `monitor.yml` (`:07` y `:37`) y el de `salud.yml`. Para parar también eso,
  nivel 6.

**Comprobar:** no aparecen ejecuciones nuevas de Monitor con evento
`workflow_dispatch`.

**Deshacer:** `npx wrangler deploy` (con `ENABLED=true` de `wrangler.json`). Si
se revocó el token: crear uno igual (solo `news-monitor`, Actions read/write,
caducidad) y cargarlo con `npx wrangler secret put GITHUB_TOKEN`. Comprobar el
siguiente `workflow_dispatch`.

## Nivel 4 · Volver a una versión anterior del Worker

**Cuándo:** un despliegue del Worker ha roto los disparos.

```powershell
npx wrangler versions list
npx wrangler rollback <version-id> -m "motivo"
```

- `versions list` enseña las 10 últimas; la activa figura en el panel, en
  Deployments.
- **Los crons no viajan con la versión**: se despliegan aparte. Tras un
  rollback, comprobar en el panel (Settings → Trigger events) que los triggers
  son los esperados.
- Una versión anterior al 14-09 no lanza el vigilante desde el reloj; queda el
  `schedule` de `salud.yml`.

**Comprobar:** el siguiente disparo aparece en GitHub y es del perfil esperado
(`full` a las :03 y :33, `fast` en el resto).

**Deshacer:** `npx wrangler deploy` desde `main`.

## Nivel 5 · Volver a una versión anterior del código

**Cuándo:** un commit ha roto el ciclo, la entrega o el dashboard.

1. Nivel 1 primero si hay envíos implicados.
2. `git revert <sha>` y `git push`. **Nunca** reescribir `main`.
3. Esperar `Comprobaciones` en verde en ese commit.
4. El siguiente disparo usa `main`. Un job en curso termina con el código con
   el que arrancó.

- **Esquema:** no se deshace una migración para volver atrás. Son aditivas y
  el código anterior ignora lo nuevo. La única reversión de esquema escrita es
  el DDL de telemetría de `20260910_run_cadence.sql` (`monitor_runs`, su vista y
  un índice): solo con consumidores parados y copia exportada, y rara vez hace
  falta, porque basta `RUN_TELEMETRY=false`.
- **Un commit que añadió una migración ya aplicada:** revertir el código no
  quita la tabla ni la columna, y está bien que no lo haga.

**Comprobar:** `Comprobaciones` en verde y el ciclo siguiente correcto.

**Deshacer:** `git revert` del commit de reversión.

## Nivel 6 · Parar todo

**Cuándo:** incidente serio sin diagnóstico, o una fuga posible.

1. Nivel 1 (`capture-only`).
2. Nivel 3 (reloj parado o token revocado).
3. `gh workflow disable monitor.yml`, `agenda.yml`, `brief.yml` y `salud.yml`.
   `keepalive.yml` se deja: evita que GitHub apague los crons por inactividad.
   `comprobaciones.yml` se deja: no toca producción.
4. Esperar a que terminen los jobs en curso (`gh run list`) y comprobar su
   resultado en lectura.

**Deshacer:** en orden inverso. Primero los workflows, después el reloj y por
último `MONITOR_MODE=full`, comprobando cada paso.

## Datos: qué contar para saber que no se ha perdido nada

Antes y después, en lectura:

- `capture_queue` por `state` y `reason`: puede crecer, nunca decrecer en total.
- `alert_deliveries` por `state`: las `sent`, `uncertain` y `undeliverable` no
  cambian por una reversión.
- `daily_briefs` por `brief_date` y `destination`: una fila por día y destino.

`audit:health` y `audit:queue` dan los totales sin publicar titulares ni ids.

## Registro de pruebas

| Fecha | Nivel | Resultado |
|---|---|---|
| 14-09-2026, 20:14–20:34 UTC | 1 · `capture-only` en producción | **Correcto.** `MONITOR_MODE=capture-only` a las 20:14:36. El ciclo de las 20:23 («Monitor (capture-only) [fast]») registró `CAPTURE_ONLY`: 3 fuentes guardadas, 0 puntuaciones, 0 planes de cola, 0 alertas, 0 llamadas a modelos. Vuelta a `full` a las 20:24:51. El ciclo de las 20:33 («Monitor (full) [full]») procesó: 2 noticias en puntuación y deduplicación, 29 fuentes y 0 fallos. Antes/después: pendientes 0/0, inciertas 0/0, bloqueadas 0/0, cierres definitivos 3/3. |
| 14-09-2026 | Documento | `test/reversion-doc.test.ts` en CI: cada variable, workflow, código y comando que cita existe, y no manda órdenes destructivas. |
| — | 2 a 6 | Sin ensayar en producción. |

Lección del propio simulacro: `gh variable list` justo después de
`gh variable set` puede enseñar todavía el valor anterior. Comprobar con
`gh variable get <NOMBRE>` y, sobre todo, con el nombre del ciclo siguiente, que
lleva el modo entre paréntesis.
