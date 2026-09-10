import { beforeEach, vi } from "vitest";
// Cualquier test debe proporcionar explícitamente su transporte simulado.
// Ningún fetch accidental puede alcanzar GitHub, fuentes, modelos o Telegram.
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("test_network_forbidden"); })); });
