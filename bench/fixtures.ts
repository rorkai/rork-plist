/**
 * Document shapes shared by the benchmark suites.
 *
 * The "auth response" is a small dict with a few binary payloads, the shape
 * of a typical authentication exchange. The "device list" is many small
 * dicts, the shape of enumeration responses. The "profile (data-heavy)" is a
 * document dominated by large binary payloads.
 */

import type { PlistValue } from "../dist/index.js";

/** Deterministic pseudo-random bytes, as a Buffer so every library accepts them. */
function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** The representative documents every benchmark measures. */
export const shapes: Record<string, PlistValue> = {
  "auth response": {
    Status: { ec: 0, ed: "Success", "server-info": "1.0" },
    spd: bytes(512, 1),
    np: "8874100170514355861",
    "session-token": bytes(256, 2),
    created: new Date("2026-07-04T10:20:30Z"),
  },
  "device list": {
    devices: Array.from({ length: 500 }, (_, i) => ({
      deviceId: `DEVICE${i.toString(16).toUpperCase().padStart(8, "0")}`,
      name: `Device ${i} & Co <primary>`,
      deviceNumber: `00008150-${i.toString(16).padStart(12, "0")}`,
      model: "iPhone17,1",
      enabled: i % 3 !== 0,
      addedDate: new Date(1_700_000_000_000 + i * 86_400_000),
    })),
  },
  "profile (data-heavy)": {
    AppIDName: "Development Profile",
    ExpirationDate: new Date("2027-07-04T00:00:00Z"),
    DeveloperCertificates: [bytes(1600, 3), bytes(1600, 4), bytes(1600, 5)],
    "der-encoded-profile": bytes(500_000, 6),
    TimeToLive: 365,
    Version: 1,
  },
};

/**
 * Rewrites a shape into the OpenStep value model, which is untyped — the
 * numbers, booleans, and dates the other formats carry become strings.
 */
export function stringifyLeaves(value: PlistValue): PlistValue {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyLeaves(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stringifyLeaves(entry!)]));
  }
  return String(value);
}
