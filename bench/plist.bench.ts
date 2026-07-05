import { bench, describe } from "vitest";

// Benchmarks measure the built artifact — the code consumers actually run —
// because vitest's on-the-fly module transform keeps cross-module constants
// as property reads that the bundled output inlines. `pnpm bench` builds
// first.
import { buildBinaryPlist, buildPlist, parseBinaryPlist, parsePlist, type PlistValue } from "../dist/index";

/**
 * Representative document shapes.
 *
 * The "auth response" is a small dict with a few binary payloads, the shape
 * of a typical authentication exchange. The "device list" is many small
 * dicts, the shape of enumeration responses. The "profile" is a document
 * dominated by large binary payloads.
 */

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

const authResponse: PlistValue = {
  Status: { ec: 0, ed: "Success", "server-info": "1.0" },
  spd: bytes(512, 1),
  np: "8874100170514355861",
  "session-token": bytes(256, 2),
  created: new Date("2026-07-04T10:20:30Z"),
};

const deviceList: PlistValue = {
  devices: Array.from({ length: 500 }, (_, i) => ({
    deviceId: `DEVICE${i.toString(16).toUpperCase().padStart(8, "0")}`,
    name: `Device ${i} & Co <primary>`,
    deviceNumber: `00008150-${i.toString(16).padStart(12, "0")}`,
    model: "iPhone17,1",
    enabled: i % 3 !== 0,
    addedDate: new Date(1_700_000_000_000 + i * 86_400_000),
  })),
};

const profile: PlistValue = {
  AppIDName: "Development Profile",
  ExpirationDate: new Date("2027-07-04T00:00:00Z"),
  DeveloperCertificates: [bytes(1600, 3), bytes(1600, 4), bytes(1600, 5)],
  "der-encoded-profile": bytes(500_000, 6),
  TimeToLive: 365,
  Version: 1,
};

const shapes = [
  { name: "auth response", value: authResponse },
  { name: "device list", value: deviceList },
  { name: "profile", value: profile },
] as const;

for (const { name, value } of shapes) {
  const xml = buildPlist(value);
  const binary = buildBinaryPlist(value);

  describe(`parse ${name} (xml ${(xml.length / 1024).toFixed(1)} KiB, binary ${(binary.length / 1024).toFixed(1)} KiB)`, () => {
    bench("parsePlist (xml)", () => {
      parsePlist(xml);
    });
    bench("parseBinaryPlist", () => {
      parseBinaryPlist(binary);
    });
  });

  describe(`build ${name}`, () => {
    bench("buildPlist (xml)", () => {
      buildPlist(value);
    });
    bench("buildBinaryPlist", () => {
      buildBinaryPlist(value);
    });
  });
}
