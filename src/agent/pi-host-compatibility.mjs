import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Only the release exercised by the consumer and embedded-host checks is enabled.
// In particular, 0.85.0 published experimental imports and must remain blocked.
export const SUPPORTED_PI_HOST = Object.freeze({ minimum: "0.85.1", maximumExclusive: "0.85.2" });

function tuple(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compare(left, right) {
  const a = tuple(left); const b = tuple(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function piHostCompatibility(version) {
  const minimum = compare(version, SUPPORTED_PI_HOST.minimum);
  const maximum = compare(version, SUPPORTED_PI_HOST.maximumExclusive);
  if (minimum == null || maximum == null) return { status: "unknown", version: version ?? null, supported: false, required: SUPPORTED_PI_HOST };
  return { status: minimum >= 0 && maximum < 0 ? "compatible" : "incompatible", version, supported: minimum >= 0 && maximum < 0, required: SUPPORTED_PI_HOST };
}

export function detectPiHostVersion(entryPath = null) {
  const candidates = [entryPath, process.env.PI_HOST_ENTRY, process.argv[1], process.env._].filter(Boolean);
  for (const candidate of candidates) {
    let resolvedEntry;
    try { resolvedEntry = realpathSync(resolve(candidate)); } catch { resolvedEntry = resolve(candidate); }
    let current = dirname(resolvedEntry);
    for (let depth = 0; current && depth < 12; depth += 1) {
      const packagePath = join(current, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") return pkg.version;
      } catch { /* keep walking */ }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

export function assertCompatiblePiHost({ version = detectPiHostVersion(), allowUnknown = true } = {}) {
  if (!version && allowUnknown) return { status: "host_not_detected", supported: null, required: SUPPORTED_PI_HOST };
  const result = piHostCompatibility(version);
  if (!result.supported) throw Object.assign(new Error(`unsupported_pi_host_version:${version ?? "unknown"};required>=${SUPPORTED_PI_HOST.minimum}<${SUPPORTED_PI_HOST.maximumExclusive}`), { code: "unsupported_pi_host_version", details: result });
  return result;
}
