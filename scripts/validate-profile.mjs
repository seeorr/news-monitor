// Node sin dependencias: antes de npm ci y antes de proporcionar secretos al job.
import { appendFileSync } from "node:fs";
const profile = process.env.MONITOR_PROFILE || "full";
const mode = process.env.MONITOR_MODE || "full";
const origin = process.env.MONITOR_ORIGIN || "manual";
if (!["fast", "full", "process"].includes(profile) || !["full", "capture-only", "process-only"].includes(mode) ||
    !["external", "schedule", "manual"].includes(origin) || (profile === "process" && mode === "capture-only")) {
  console.error(JSON.stringify({ code: "PROFILE_INVALID" })); process.exitCode = 1;
} else {
  console.log(JSON.stringify({ code: "PROFILE_VALID", profile, trigger: origin }));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "valid=true\n");
}
