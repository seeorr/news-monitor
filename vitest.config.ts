import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-no-network.ts"],
    // Hilos y no procesos, por un fallo de la suite que no era de la suite: con
    // el pool `forks`, al terminar, vitest mata sus workers con ChildProcess.kill
    // y en Windows eso devuelve EPERM cuando el hijo ya se esta muriendo. El
    // error llega en un `'error'` que nadie escucha, asi que Node se cae DESPUES
    // de haber pasado los 782 tests: exit 1 sin un solo test rojo, que es
    // justo lo que no se puede leer como lo que es.
    //
    // Medido el 12-09-2026: con `forks`, una de cada cinco suites completas
    // moria asi, y las cuatro que sobrevivian avisaban igual por consola; con
    // `threads`, catorce pasadas sin un solo aviso y la misma duracion.
    //
    // El aislamiento por archivo sigue vigente (`isolate`, por defecto), que es
    // de lo que dependen los tests, y no de tener un proceso aparte. Volver es
    // borrar esta linea.
    pool: "threads",
  },
});
