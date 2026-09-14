# LLM gratuitos para News Monitor

Revisión: 14-09-2026, 11:00 Madrid. Groq activado en producción en `73af838`.
El secreto está guardado como `GROQ`; el workflow lo admite como alias de
`GROQ_API_KEY`. OpenRouter sigue sin clave y no participa todavía.

La [prueba real aislada](https://github.com/seeorr/news-monitor/actions/runs/34825380786)
pasó con dos peticiones: scoring 930/145 tokens y análisis 591/354 tokens de
entrada/salida. También pasaron typecheck y 827 pruebas en GitHub.
El [primer ciclo de producción](https://github.com/seeorr/news-monitor/actions/runs/34825503168)
puntuó cuatro noticias y confirmó una entrega a Telegram a las 10:59:41 Madrid,
sin errores. Cola: 77 → 73 pendientes. No se da por saneado todo el backlog.

Variables operativas: `MAX_SCORING_PER_CYCLE=4`, `MAX_DEEP_PER_CYCLE=1`,
`AI_CALLS_PER_DAY=180`. Valores anteriores: 12, 3 y 120 respectivamente.
El aumento deja 60 intentos adicionales el día de la activación sin borrar
reservas. Revisar consumo observado antes de nuevos aumentos. La cuota del
proveedor sigue siendo independiente del cupo interno.

## Claves que hay que crear

| Proveedor | Función | Crear clave | Condición de coste cero |
|---|---|---|---|
| Groq | Principal; basta esta clave para empezar | [Groq Console](https://console.groq.com/keys) | Cuenta en Free, sin pasar a Developer de pago |
| OpenRouter | Respaldo opcional | [API Keys](https://openrouter.ai/settings/keys) | No comprar créditos; solo rutas gratuitas |

En GitHub, añadirlas en [Actions Secrets del repositorio](https://github.com/seeorr/news-monitor/settings/secrets/actions):

- `GROQ_API_KEY`: clave de Groq.
- El workflow también acepta el nombre `GROQ`, usado al crear el secreto.
- `OPENROUTER_API_KEY`: clave de OpenRouter, si se crea el respaldo.

Para probar en local, usar los mismos nombres en `.env`, que está excluido de
git. No guardar claves en Variables, documentación ni comandos con el valor
escrito. No hace falta borrar la clave antigua de Anthropic.

## Configuración

Estas son Variables de Actions, no secretos. Sus valores por defecto ya están
en el código y en el workflow; no hace falta crearlas para empezar.

```dotenv
LLM_PROVIDERS=groq,openrouter
GROQ_MODEL_SCORING=openai/gpt-oss-120b
GROQ_MODEL_ANALYSIS=openai/gpt-oss-120b
OPENROUTER_MODEL=openrouter/free
```

Solo se incluyen proveedores seleccionados cuya clave existe. Si solo existe
OpenRouter, funcionará con su cuota menor. Se admite invertir el orden.
Los modelos Groq admitidos son `openai/gpt-oss-120b` y `openai/gpt-oss-20b`;
ambos soportan JSON Schema estricto. Los modelos de OpenRouter deben ser
`openrouter/free` o un identificador terminado en `:free`.

`MODEL_SCORING` y `MODEL_ANALYSIS` siguen siendo ajustes de Anthropic. No
cambian los modelos gratuitos. Anthropic exige `LLM_PROVIDERS=anthropic`
en exclusiva. Nunca entra como respaldo automático de los gratuitos.

## Comprobación antes de activar

1. Ejecutar `npm run verify:llm`. Solo comprueba configuración y presencia de
   claves. Sin claves devuelve `LLM_CHECK_MISSING_KEYS` y salida 1.
2. Con las claves listas, ejecutar `npm run verify:llm -- --live`. Usa un
   comunicado público histórico del BCE. Puntúa y analiza sin Neon, watchlist
   ni Telegram. Consume cuota gratuita: normalmente dos peticiones, hasta
   seis si hay respaldos y reintento antifabricación.
3. Exigir `LLM_CHECK_OK`; después revisar calidad sobre una muestra de noticias
   públicas. La prueba comprueba transporte, esquema y cifras, no la calidad
   editorial. Los tests HTTP simulados tampoco acreditan cuota ni disponibilidad.
4. Publicar los cambios verificados y configurar Secrets. Completado para Groq
   el 14-09; repetir la prueba si se incorpora otro proveedor.
5. Observar el siguiente ciclo automático y `npm run audit:health`. Comprobar
   nuevas puntuaciones en `monitor_runs` y proveedor/modelo/tokens en
   `news_usage.ai_record`. Confirmar entregas nuevas, sin usar `--force`.

El script de prueba no arranca el monitor ni envía mensajes. No ejecutar el
ciclo como una mera comprobación: el ciclo normal sí escribe y puede enviar.

## Límites y comportamiento ante fallos

Groq publica para ambos GPT-OSS: 30 solicitudes/minuto, 1.000/día,
8.000 tokens/minuto y 200.000/día. La cuota efectiva depende de la organización;
comprobarla en su panel. Una noticia incluye prompt y salida: el límite de
tokens suele llegar antes que el de solicitudes. [Límites oficiales](https://console.groq.com/docs/rate-limits).

OpenRouter sin compras permite 50 solicitudes gratuitas/día y 20/minuto;
los intentos fallidos también cuentan. `openrouter/free` elige un modelo
compatible y su calidad puede variar. Se guarda `resolvedModel` cuando la
respuesta lo proporciona. [Router gratuito](https://openrouter.ai/docs/guides/routing/routers/free-router),
[límites oficiales](https://openrouter.ai/docs/api-reference/limits).

La implementación:

- Pide JSON Schema estricto y valida otra vez con Zod.
- Limita salida a 2.048 tokens en scoring y 4.096 en análisis; incluye
  razonamiento cuando el proveedor lo cuenta dentro de esa salida.
- Comparte un plazo de 20 segundos en fast y 60 en full/process entre
  proveedores. No multiplica el plazo por cada respaldo.
- Ante HTTP, red o timeout, aparta al proveedor y prueba el siguiente. Guarda
  `retryAt` en la reserva del intento, dentro de `news_usage.ai_record`.
  El siguiente ciclo lee ese plazo antes de reservar o hacer HTTP. No se
  consumen intentos contra un proveedor todavía en espera.
- Respeta `Retry-After` en segundos o fecha HTTP, hasta siete días. Sin un
  plazo válido espera 15 minutos ante 429, seis horas ante errores de acceso
  o configuración (400/401/402/403/404), y un minuto ante red/timeout/otros HTTP.
  Cada ciclo puede probar el respaldo durante esa espera. La pausa termina
  automáticamente; no se borran reservas ni se reinician cuotas.
- Ante JSON, esquema, truncamiento o rechazo de contenido, prueba el respaldo.
  Una respuesta no válida nunca se convierte en una puntuación ficticia.
- Reserva cada intento antes de hacer red, también respaldos y reintentos.
  Un error de cuota interna o persistencia no provoca más peticiones.
- Si no queda ningún proveedor disponible, conserva la noticia para reintento
  y detiene el resto del lote. Las demás candidatas permanecen pendientes.
- OpenRouter lleva `require_parameters=true`, `data_collection=deny` y precios
  máximos de entrada/salida cero. Si no encuentra una ruta elegible, falla.
- Groq no ofrece en esta integración una prueba del plan de facturación de la
  cuenta: mantenerla en Free. Su coste queda desconocido en el ledger hasta
  verificar externamente el plan; no se reutilizan tarifas de Anthropic.

El cupo local es común a proveedores. Su valor de código por defecto sigue
siendo 120; producción usa 180 desde la activación. Cambiar de proveedor no
reinicia reservas. Se renuevan a las 00:00 UTC, el 15-09 a las 02:00 de Madrid.
El cupo anterior estaba agotado; se amplió después de medir la prueba real.
No se borró el ledger. Revisar capacidad después de observar consumo real.

## Por qué estos proveedores

El [listado aportado](https://github.com/raullenchai/free-llm-api-resources)
sirve para descubrir opciones; mandan las condiciones oficiales verificadas.

- Groq mantiene Free sin tarjeta y structured outputs para los modelos
  seleccionados. [Free tier](https://community.groq.com/t/is-there-a-free-tier-and-what-are-its-limits/790),
  [structured outputs](https://console.groq.com/docs/structured-outputs).
- OpenRouter ofrece el respaldo limitado anterior y controles explícitos de
  precio y datos. [Privacidad](https://openrouter.ai/docs/guides/privacy/data-collection).
- Cerebras queda fuera: su oferta actual es crédito temporal, no free tier
  permanente. [FAQ oficial](https://inference-docs.cerebras.ai/support/rate-limits).
- Gemini no se integra en esta primera versión. Sus condiciones para ofrecer
  clientes API a usuarios del EEE requieren resolver el encaje del servicio;
  no se interpreta esto como prohibición general de uso gratuito en España.
  [Términos](https://ai.google.dev/gemini-api/terms).
- Workers AI queda como siguiente opción: cuota diaria de 10.000 neuronas,
  con selección de modelos y consumo por medir. [Precios](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Los prompts contienen datos del evento, sin posiciones ni importes de cartera.
La selección de eventos puede revelar interés en ciertos activos. Groq permite
Zero Data Retention; revisar el ajuste de cuenta. [Uso de datos](https://console.groq.com/docs/your-data).

## Reversión y pendientes

`LLM_PROVIDERS=groq` elimina el respaldo. `LLM_PROVIDERS=openrouter` permite usar
solo el respaldo si tiene cuota. `MONITOR_MODE=capture-only` conserva capturas
mientras se resuelve un incidente. Volver a Anthropic requiere elegirlo
explícitamente y disponer de saldo. Ningún cambio necesita migración SQL.

El observador distingue cuota diaria real de motivos históricos de la cola.
Publica reservas usadas, límite vigente y saldo de intentos. Solo acredita
procesamiento con una ejecución completada correctamente; un ciclo iniciado
o fallido no basta. Separa descartes editoriales, entregas aplazadas y bloqueos.
`healthy` exige que todo el circuito esté acreditado.

Pendientes: medir tokens y tasa de aceptación; ajustar capacidad sin superar
Free; calibrar importancia con una muestra etiquetada; unificar el control
antifabricación legacy. La espera del proveedor conserva los fallos visibles:
el ciclo puede seguir marcándose fallido mientras no haya ningún LLM disponible.
