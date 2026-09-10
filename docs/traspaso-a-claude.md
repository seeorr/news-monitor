# Traspaso a Claude: continuar la activación de News Monitor

Preparado el **10-09-2026 a las 17:47 Europe/Madrid** porque Alberto deja esta
sesión y continuará con Claude. Lee este archivo completo antes de actuar.

## Objetivo y límites

Terminar las tareas de activación registradas en la ficha del proyecto:
`C:\Users\alber\Second brain\01-projects\news-monitor\README.md`.
Código: `C:\Users\alber\Second brain\01-projects\news-monitor\codigo`.
Lee las instrucciones AGENTS.md/CLAUDE.md aplicables. Conserva los cambios ajenos.
No modifiques otros proyectos ni `.brain`. Alberto autorizó actualizar esta ficha.
No hagas PDF.

Alberto autorizó expresamente crear el commit de cadencia y publicar el conjunto
revisado, incluidos los tres commits anteriores. También completó el acceso a
Cloudflare y cargó el secreto de GitHub. Esos pasos están hechos: no volver a
solicitar cuenta, token o migraciones ya aplicadas.

**La fase actual es observación sin modelos ni Telegram.** No habilites el
procesamiento solo porque el código está publicado. Primero verifica el reloj,
la observación y el backlog. La autorización de publicación no debe interpretarse
como permiso para reenviar retrospectivamente el incidente BCE, gastar fuera del
presupuesto, contratar servicios o saltarse la fase de observación. Si las nuevas
instrucciones de Alberto no autorizan aún modelos/envíos reales, solicita esa
autorización al llegar a la activación final, con el resultado revisable delante.

## Estado remoto comprobado al entregar

### GitHub

- Repositorio público `seeorr/news-monitor`; rama predeterminada `main`.
- HEAD publicado: `f1c1e655706e9f87c00b26362ad2a7145b100bd4`.
- Incluye `9ef925e`, `f0e0ee2`, `037e77a` y el commit de cadencia `f1c1e65`.
- Monitor: **activo**. Respaldo cron :07 y :37 UTC conservado.
- Variables de Actions: `MONITOR_MODE=capture-only`, `RUN_TELEMETRY=true`.
- **Agenda y Resumen de mañana: pausados manualmente** durante la observación.
  No olvides restaurarlos al terminar esa fase y habilitar las salidas autorizadas.
- Latido: activo; sin cambios.
- Configuración anterior para reversión: `.cache/activation-remote-settings-before.json`.
  Antes, los tres workflows estaban activos y no existían esas dos variables.

### Cloudflare

- Wrangler ya autenticado en este equipo. No leas su archivo de credenciales.
- Cuenta usada: `c96b492fba1c3bb807b4b2bdf5496777`.
- Worker `news-monitor-clock`, sin rutas públicas ni manejador HTTP.
- Cron registrado: `3,13,23,33,43,53 * * * *` UTC.
- Versión activada: `0a109b3f-d942-4412-9dd5-e3b4483e4213`.
- Variables remotas verificadas mediante `versions view`: `ENABLED=true`,
  `STRATEGY=fast-only`, `MONITOR_MODE=capture-only`, repo `seeorr/news-monitor`,
  workflow `monitor.yml`, referencia `main`.
- `GITHUB_TOKEN` existe como `secret_text`. Solo se comprobó el nombre y el tipo.
  Alberto lo creó siguiendo la indicación de un repositorio, Actions read/write
  y 30 días. No se ha inspeccionado su valor ni certificado su alcance desde GitHub.
- El archivo versionado `wrangler.json` conserva **ENABLED=false**: no hagas un
  deploy sin revisar los overrides, porque apagaría el reloj activo.
- Activación: aproximadamente **17:31 Madrid / 15:31 UTC**.
- Los primeros despliegues fallaron parcialmente con `10063` (cuenta nueva sin
  subdominio Workers). Se resolvió al abrir Workers & Pages en la cuenta correcta.
  No repetir ese diagnóstico si no aparece otra vez el error.

**Pendiente crítico:** a las **17:46 Madrid** todavía no aparecía en GitHub ningún
dispatch externo. Las dos ejecuciones nuevas eran manuales. La configuración está
activa, pero NO se ha demostrado aún que Cloudflare dispare correctamente GitHub.
Cloudflare declara hasta 15 minutos de propagación de cambios; el siguiente slot
tras esa ventana es :53. Revisa primero lo ocurrido desde la última lectura.

### Neon

- Credenciales existentes accesibles con `loadDotEnv()` y el driver del proyecto;
  no las imprimas. Diagnóstico solo con SELECT, nunca ejecutando main para mirar.
- Aplicadas **en una transacción** a las **15:23:13 UTC** las tres migraciones:
  `20260910_capture_queue.sql`, `20260910_news_control.sql`, `20260910_run_cadence.sql`.
- 17 sentencias; verificadas las cinco tablas/vista, los 12 índices de los nuevos
  módulos y `reserve_news_budget`.
- Resultado: `.cache/activation-migrations-result.json`.
- **No repetir `npm run db:migrate`**: el migrador general reejecuta todos los SQL.
  `.cache/apply-cadence-migrations.ts` ya se ejecutó; su guardia rechaza el esquema
  existente. No quitar esa guardia para forzar una repetición.
- Última lectura de entrega: 14 filas `sent`, último acuse **14:20:37 UTC** del
  10-09, anterior a estas pruebas. Sin nuevos envíos durante la observación.

## Pruebas reales ya realizadas

1. [Fast, ejecución 34495563870](https://github.com/seeorr/news-monitor/actions/runs/34495563870):
   capture-only, correcta, final de Actions 15:26:06 UTC. 84 apariciones,
   79 únicas, 10 pendientes, tres fuentes correctas, cero fallidas.
2. [Full, ejecución 34495721148](https://github.com/seeorr/news-monitor/actions/runs/34495721148):
   capture-only, correcta, final 15:27:59 UTC. 181 apariciones, 100 nuevas únicas,
   31 pendientes acumuladas, 21 fuentes correctas, cero fallidas.
3. Ambas: cero puntuaciones, `news_usage` vacía, ledger sin nuevos acuses.
   Las filas BCE/Fed conservaron primera captura y aumentaron apariciones al repetirse.

Esto verifica captura y persistencia reales. **No verifica la puntualidad del
reloj externo ni los objetivos publicación→captura/Telegram para noticias nuevas.**
Las pruebas locales previas pasaron: 663 tests / 44 archivos, 26 comprobaciones
SQL con PGlite, typecheck, build, actionlint y dry-run. Detalle completo en
`docs/verificacion-cadencia.md`; no repetir toda la suite sin cambios que lo justifiquen.

## Backlog que bloquea habilitar envíos a ciegas

La revisión de lectura encontró pendiente el comunicado BCE «Monetary policy
decisions» publicado **10-09 a las 12:15 UTC**, sin entrega por su propio id.
La declaración «Christine Lagarde, Boris Vujčić: Monetary policy statement» de
las **13:00 UTC** ya tiene `sent` por su id. También hay copias de prensa pendientes.
Hay que resolver explícitamente esa relación y evitar el reenvío retrospectivo
del incidente. No inventes que el comunicado fue enviado: son ids distintos.

El consumidor descarta ids ya procesados y agrupa hechos equivalentes, pero no se
ha demostrado todavía la equivalencia de estos registros heredados sin entradilla.
No marques `sent` sin acuse, no fabriques puntuaciones, no alteres fechas, no
liberes `sending`/`uncertain` ni uses `--force` para limpiar el arranque.
Si se necesita una exclusión editorial, debe tener motivo veraz, persistencia y
pruebas; no reutilices un motivo falso para saltarte el estado de la cola.

## Orden de continuación

1. Releer git/status, workflows, variables y runs; no asumir que esta fotografía
   sigue actualizada. Consultar Neon en lectura y distinguir trigger `external`,
   `schedule` y `manual` en `monitor_runs`.
2. Confirmar el primer dispatch automático. Si no existe, inspeccionar los eventos
   del cron/logs seguros en Cloudflare. Un error 401/403/404/422 no es propagación.
   Verificar scope/ref/workflow sin revelar el token ni reenviar un resultado incierto.
3. Observar varias horas desde las 17:31: diferencias entre ejecuciones externas,
   fuentes correctas/fallidas, únicas/apariciones, antigüedad y ausencia de IA/envíos.
   Dos horas sin procesar pueden producir `aged_queue` esperado; declararlo, no borrarlo.
4. Resolver el backlog del BCE y revisar cuotas/coste. Mantener los límites actuales.
5. Con las verificaciones y autorizaciones de efectos resueltas, habilitar primero
   procesamiento con fast-only; verificar idempotencia y acuses reales. Después pasar
   a mixed, conservar respaldo GitHub y restaurar Agenda/Resumen según sus estados previos.
6. Medir varias publicaciones reales futuras. Mantener pendientes los objetivos aún
   no observados; actualizar la ficha, este traspaso y el registro con evidencia.

## Herramientas y evidencia local

Desde `codigo/`:

```powershell
gh run list --workflow monitor.yml --limit 20 --json databaseId,event,status,conclusion,createdAt,displayTitle
node --import tsx .cache/verify-live-capture.ts
npm run audit:health
```

Los dos últimos comandos son de lectura. `audit:health` puede salir con código 1
por salud retrasada sin que el SQL haya fallado. **No añadir `--notify`.**

Archivos útiles, todos dentro del repositorio:

- `docs/activacion-cadencia.md`: registro operativo; la versión local está más
  actualizada que la incluida inicialmente en `f1c1e65`.
- `docs/cadencia-cloudflare.md`: arquitectura, costes, permisos, activación y reversión.
- `.cache/activation-first-fast.json`, `.cache/activation-live-capture.json`:
  resultados agregados de las dos primeras capturas.
- `.cache/activation-critical-backlog.json`: revisión del backlog, de uso local.
- `.cache/review-critical-backlog.ts`: consulta de lectura de críticos e índices.
- `.cache/activation-release-manifest.json`: referencia anterior a publicar.
- `.cache/cadence-baseline/preserved-files.json`: hashes de los cambios ajenos.
- `.cache/watch-clock.mjs`: lector temporal de tail que solo imprime estado seguro;
  no sustituye un registro histórico. La escucha de esta sesión ya se ha detenido.

## Estado local y coordinación

Los dos archivos ajenos conservados sin commit son:
`docs/dos-niveles-noticias.md` y `scripts/evaluar-noticias.ts`. No los incluyas en un
commit nuevo ni los reviertas sin indicación expresa. Hay cambios documentales
locales de este traspaso y del registro, además de la ficha del vault. No se han
publicado automáticamente como parte del traspaso; comprueba el estado real al llegar.

La automatización de Codex **Observar activación de News Monitor**
(`observar-activaci-n-de-news-monitor`) está **PAUSADA** por petición de traspaso.
No habrá otro agente de esta sesión modificando la ficha durante tu trabajo.
Cloudflare y GitHub siguen activos remotamente en captura sin procesamiento;
cerrar Codex no los apaga. **No hay vigilancia local prometida mientras Alberto
está ausente.** Debes retomar la observación tú.
