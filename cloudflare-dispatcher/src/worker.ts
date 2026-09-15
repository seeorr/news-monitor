/**
 * El punto de entrada del reloj. **Solo exporta el manejador por defecto.**
 *
 * workerd trata cada export de este módulo como un posible punto de entrada, y
 * una constante exportada aquí hace que rechace el Worker entero en local. La
 * lógica, las constantes y los tipos viven en `reloj.ts`;
 * `test/clock-worker.test.ts` falla si este archivo vuelve a exportar otra cosa.
 */
import { scheduled, type Env } from "./reloj.ts";

export default {
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    await scheduled(controller, env);
  },
};
