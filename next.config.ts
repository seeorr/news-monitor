import type { NextConfig } from "next";

/**
 * El dashboard vive en el mismo paquete que el ciclo de ingesta, y no en uno
 * aparte, por una razon concreta: sus paginas leen `src/db/lectura.ts` y su
 * formulario de alta llama a `src/db/watchlist.ts`. Con dos paquetes habria que
 * elegir entre duplicar ese SQL —incluido el `on conflict` que ya tuvo un fallo
 * silencioso— o montar un truco de resolucion entre carpetas. Ninguna de las dos
 * merece la pena para un proyecto de este tamaño.
 *
 * El precio es que el cron instala tambien React. Sale gratis —las Actions son
 * ilimitadas en un repositorio publico— y no arriesga nada: `npm ci` instala lo
 * que diga el lockfile, asi que el arbol del dashboard solo puede cambiar cuando
 * alguien lo cambia a proposito.
 */
const nextConfig: NextConfig = {
  typedRoutes: true,
};

export default nextConfig;
