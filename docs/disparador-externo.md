# Disparador externo: preparado, sin activar

Revisión documental del 10 de septiembre de 2026. No se creó cuenta, job ni token, no se entregaron credenciales y no se disparó ningún workflow. Esta guía describe pasos futuros de activación. Un disparo real ejecutaría el monitor con sus credenciales de producción y podría enviar Telegram.

## Motivo y alcance

La lectura reproducible de Actions a las **12:19:50 UTC del 10-09-2026** encontró **11 runs programados creados frente a 48 franjas previstas en 24 horas (22,92 %)**. Todos terminaron con conclusión `success`. Es un cociente entre ejecuciones observadas y slots solicitados; no asigna cada ejecución retrasada a un slot ni mide porcentaje de noticias procesadas. GitHub documenta retrasos por carga y posibilidad de descartar jobs programados, especialmente al inicio de la hora. [Comportamiento de schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

La consulta solicitó hasta 500 runs de `monitor.yml`; devolvió 21, con historia desde el 08-09-2026, suficiente para cubrir la ventana del 09-09 a las 12:19:50 al 10-09 a las 12:19:50. Dentro había además **3 manuales**: 2 `success` y 1 `cancelled`. Ninguno aumenta la cuenta de cron. La foto preliminar a las 12:01 UTC mencionaba los dos manuales exitosos; la lectura ampliada conserva también el cancelado.

| Medida de creación de runs programados | Resultado |
|---|---|
| Mayor hueco entre dos runs observados dentro de la ventana | 185,4 min: 10-09 01:24:47 → 04:30:11 UTC |
| Borde inicial censurado: inicio de ventana → primer run | 326,655 min: 09-09 12:19:50 → 17:46:30 UTC |
| Borde final censurado: último run → cierre de lectura | 30,762 min: 10-09 11:49:05 → 12:19:50 UTC |
| `startedAt` de los 14 runs de la ventana | Idéntico a `createdAt`; inicio del trabajo **sin verificar** |

Los bordes describen silencio observado dentro de la ventana; no son intervalos completos entre ejecuciones. `createdAt` es creación del run. `startedAt` se conserva como valor reportado; cuando coincide con creación puede ser un marcador inicial, por lo que no se interpreta como espera cero ni inicio del job. Tampoco una conclusión `success` verifica la captura interna ni la entrega de Telegram.

Repetir sin ejecutar el monitor:

```powershell
npx vitest run test/cadencia.test.ts
npx tsx scripts/auditar-cadencia.ts
```

El script solo invoca `gh run list --workflow monitor.yml --limit 500` con campos de fechas, evento, estado, conclusión e id. No lee títulos ni logs, no dispara workflows y no carga `.env`. Imprime JSON de métricas y guarda copia local en `.cache/cadencia-*.json`. Esta lectura quedó en `.cache/cadencia-2026-09-10T12-19-50-710Z.json`. Si el límite de 500 no alcanza el principio de la ventana o hay fechas inválidas, el informe declara cobertura incompleta/incierta.

La propuesta usa **cron-job.org → GitHub workflow_dispatch → `monitor.yml`**. El tercero solo solicita una ejecución corta de Actions. La cola persistente protege lo ya capturado durante los huecos; ningún disparador puede recuperar una entrada que desapareció del RSS antes de la primera captura.

El workflow existente admite `workflow_dispatch`, tiene `concurrency.group: monitor`, `cancel-in-progress: false` y un tiempo máximo de 10 minutos. No se añade otro workflow ni se reserva un runner para dormir. El scheduler externo no espera a que termine el ciclo: recibe la aceptación de GitHub.

## Coste y límites consultados

- cron-job.org declara servicio gratuito, mínimo de un minuto y número de jobs sujeto a uso razonable. Las visitas tienen un máximo estándar de 30 segundos y leen hasta 64 KB de respuesta. Dos llamadas por hora a una API que acepta el disparo encajan en estos límites. La puntualidad final sigue requiriendo medición, no se asume un SLA. [FAQ oficial](https://cron-job.org/en/faq/).
- Su API de **gestión** permite por defecto 100 solicitudes/día; no es el límite de ejecuciones de un job. La configuración admite POST, cabeceras, cuerpo y zona horaria. Su historial distingue hora planeada, real y jitter. No hace falta integrar esa API para crear manualmente un único job. [Documentación oficial](https://docs.cron-job.org/rest-api.html).
- GitHub permite disparar un workflow con un token de alcance fino y permiso **Actions: write** para el repositorio elegido. `repository_dispatch` exigiría **Contents: write**, una capacidad de escritura innecesaria aquí. [workflow_dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [repository_dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
- El límite REST habitual de un PAT es 5.000 solicitudes/hora compartido con otras aplicaciones del usuario; dos disparos/hora no lo agotan. Los límites secundarios siguen aplicando. El ejecutor de Actions y cualquier API llamada por el monitor conservan sus propias condiciones y presupuestos. [Límites de Actions y REST](https://docs.github.com/en/actions/reference/limits).

## Configuración revisable

Preparar **un único job**, inicialmente deshabilitado, con estos valores. `OWNER` y `REPO` se obtienen del remoto existente; no usar una URL inferida de otro proyecto.

| Campo | Valor |
|---|---|
| Método | `POST` |
| URL | `https://api.github.com/repos/OWNER/REPO/actions/workflows/monitor.yml/dispatches` |
| Zona | `UTC` |
| Minutos | `7,37` de cada hora, todos los días |
| Timeout | 30 segundos |
| `Accept` | `application/vnd.github+json` |
| `Content-Type` | `application/json` |
| `X-GitHub-Api-Version` | `2026-03-10` |
| `Authorization` | `Bearer` seguido del token, introducido solo en la configuración privada del servicio |
| Cuerpo JSON | `{"ref":"main"}` después de confirmar que main es la referencia desplegada |
| Respuestas guardadas | Desactivadas salvo necesidad puntual de diagnóstico |
| Estado inicial | Deshabilitado |

La versión documentada `2026-03-10` devuelve HTTP 200 con `workflow_run_id`, `run_url` y `html_url`. Integraciones fijadas a versiones antiguas pueden devolver 204: no confundir ausencia de cuerpo con fracaso. **200/204 acredita aceptación del disparo, no captura completada ni entrega de mensajes.** Comprobar el run real mediante Actions. [Respuesta documentada](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Procedimiento de activación futura

1. Revisar que el código, migración necesaria y variables autorizadas estén en la versión que debe ejecutar el job. Leer `monitor.yml`, el remoto, el estado del workflow y la medición de cadencia. No usar el botón de prueba con credenciales reales durante una preparación local.
2. El propietario crea un token de alcance fino para **solo este repositorio**, `Actions: read and write`, con caducidad corta y un recordatorio propio de renovación. No conceder `Contents: write`, administración ni acceso a todos los repositorios. El token permite más acciones que únicamente este disparo; sigue siendo una credencial de escritura limitada al repositorio.
3. Crear el job deshabilitado desde el servicio elegido y revisar los campos anteriores. Introducir el token en la cabecera privada. No ponerlo en URL, cuerpo, README, issues, capturas o logs. **El proveedor externo recibe y conserva ese token para poder llamar a GitHub**; debe aceptarse ese intercambio antes de activar. No necesita claves de Neon, Anthropic ni Telegram.
4. Tras autorización para operar producción, habilitar una ejecución de prueba. Leer la respuesta y buscar el workflow por `event=workflow_dispatch`, hora y run ID. Confirmar por separado finalización, métricas de captura, pendientes y ausencia de entregas duplicadas. Si llega 401/403/404, corregir referencia, permisos o token; no sustituirlo por un token global.
5. Habilitar la cadencia de :07 y :37. Mantener provisionalmente `schedule` como respaldo solo durante la comparación. Los dos caminos comparten `concurrency: monitor` y la persistencia protege entregas, pero pueden generar dos ejecuciones secuenciales y consumir presupuesto dos veces. `concurrency` evita solapamiento, **no garantiza una sola ejecución por franja**.
6. Medir 24–48 horas: disparos aceptados, runs creados, runs terminados, retraso desde hora prevista, mayor hueco y edad de pendientes. Si la doble ejecución perjudica el presupuesto, retirar posteriormente el `schedule` de GitHub en un cambio revisado y autorizado. No aumentar el cupo de scoring para compensar una incertidumbre de cadencia.
7. Configurar los avisos de fallo/deshabilitación y revisar caducidad del token en el propio servicio. Un monitor de salud debe detectar también un job que deja de disparar: un historial lleno de éxitos pasados no demuestra que el siguiente esté programado.

## Reversión

Deshabilitar primero el job externo y comprobar que deja de crear runs. Revocar después el token específico si ya no se usará. Restaurar el `schedule` original si se había retirado; la cola y el registro de entregas permanecen. No borrar pendientes para forzar una vuelta, no relanzar un envío ambiguo y no reiniciar estados de Telegram.

Si una ejecución queda en curso al desactivar el scheduler, esa ejecución puede terminar: desactivar el disparador solo impide las futuras. Comprobar su resultado en lectura antes de cualquier acción posterior. Registrar la hora de reversión y repetir la auditoría de cadencia para que el sistema no vuelva a parecer puntual solo porque sus runs están verdes.

## Verificado y pendiente

**Verificado en local/lectura:** configuración actual de `monitor.yml`, huecos de la foto indicada y documentación oficial sobre límites, API, permisos y respuesta. La selección de workflow_dispatch evita necesitar permiso de escritura de contenidos.

**Pendiente en producción:** crear y revisar el job/token por su propietario, una prueba autorizada, comprobar entrega real, medir puntualidad 24–48 horas y decidir si se conserva schedule. No hay afirmación de frecuencia garantizada ni de servicio ya activo.
