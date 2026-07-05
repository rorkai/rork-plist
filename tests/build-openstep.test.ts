import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildOpenStepPlist,
  parseBinaryPlist,
  parseOpenStepPlist,
  parsePlist,
  PlistBuildError,
  type PlistValue,
} from "../src/index";
import { describe, test } from "node:test";

const execFileAsync = promisify(execFile);

describe("strings", () => {
  test("writes bare tokens when the grammar reads them back verbatim", () => {
    expect(buildOpenStepPlist("hello")).toBe("hello\n");
    expect(buildOpenStepPlist("/usr/local/bin:1.2.3")).toBe("/usr/local/bin:1.2.3\n");
  });

  test("quotes strings the bare alphabet cannot carry", () => {
    expect(buildOpenStepPlist("a b")).toBe('"a b"\n');
    expect(buildOpenStepPlist("")).toBe('""\n');
    expect(buildOpenStepPlist("café 😀")).toBe('"café 😀"\n');
    expect(buildOpenStepPlist("x=y")).toBe('"x=y"\n');
  });

  test("quotes tokens that would read as comments", () => {
    expect(buildOpenStepPlist("//x")).toBe('"//x"\n');
    expect(buildOpenStepPlist("x/*y")).toBe('"x/*y"\n');
    // A '//' later in the token is fine bare; the platform parser keeps
    // scanning mid-token.
    expect(buildOpenStepPlist("x//y")).toBe("x//y\n");
  });

  test("escapes quotes, backslashes, and control characters", () => {
    expect(buildOpenStepPlist('a"b')).toBe('"a\\"b"\n');
    expect(buildOpenStepPlist("a\\b")).toBe('"a\\\\b"\n');
    expect(buildOpenStepPlist("a\nb\tc\rd")).toBe('"a\\nb\\tc\\rd"\n');
    expect(buildOpenStepPlist("\u0007")).toBe('"\\007"\n');
    expect(buildOpenStepPlist("\u007f")).toBe('"\\177"\n');
  });

  test("spells lone surrogates as \\U escapes and keeps pairs literal", () => {
    expect(buildOpenStepPlist("\ud83d")).toBe('"\\Ud83d"\n');
    expect(buildOpenStepPlist("\ud83d\ude00")).toBe('"\ud83d\ude00"\n');
  });
});

describe("containers and data", () => {
  test("writes data as hex in four-byte groups", () => {
    expect(buildOpenStepPlist(new Uint8Array([1, 2, 254]))).toBe("<0102fe>\n");
    expect(buildOpenStepPlist(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBe("<01020304 0506>\n");
    expect(buildOpenStepPlist(new Uint8Array(0))).toBe("<>\n");
  });

  test("indents nested containers with tabs by default", () => {
    const text = buildOpenStepPlist({ list: ["a", "b c"], nested: { key: "value" } });

    expect(text).toBe('{\n\tlist = (\n\t\ta,\n\t\t"b c"\n\t);\n\tnested = {\n\t\tkey = value;\n\t};\n}\n');
  });

  test("writes single-line bodies with indent disabled", () => {
    expect(buildOpenStepPlist({ a: "1", b: ["x", "y"] }, { indent: false })).toBe("{ a = 1; b = (x, y); }\n");
    expect(buildOpenStepPlist({}, { indent: false })).toBe("{}\n");
    expect(buildOpenStepPlist([], { indent: false })).toBe("()\n");
  });

  test("quotes keys outside the bare alphabet", () => {
    expect(buildOpenStepPlist({ "a b": "c" }, { indent: false })).toBe('{ "a b" = c; }\n');
  });

  test("omits dictionary keys whose value is undefined, like the other builders", () => {
    expect(buildOpenStepPlist({ dropped: undefined, kept: "1" } as never, { indent: false })).toBe("{ kept = 1; }\n");
  });
});

describe("the value model", () => {
  test.each([
    ["a number", 42, "$"],
    ["a boolean", true, "$"],
    ["a bigint", 42n, "$"],
    ["a date", new Date(), "$"],
    ["null", null, "$"],
    ["undefined at the root", undefined, "$"],
    ["undefined in an array", ["a", undefined], "$[1]"],
    ["a nested number", { a: ["x", 1] }, "$.a[1]"],
    ["a class instance", new Map(), "$"],
  ])("rejects %s with its path", (_label, value, path) => {
    expect(() => buildOpenStepPlist(value as never)).toThrow(PlistBuildError);
    expect(() => buildOpenStepPlist(value as never)).toThrow(path);
  });

  test("rejects circular references instead of recursing forever", () => {
    const cyclic: PlistValue[] = [];
    cyclic.push(cyclic);

    expect(() => buildOpenStepPlist(cyclic)).toThrow(/circular reference/u);
  });
});

describe("round trips", () => {
  test("a pbxproj-shaped document survives parse, edit, and rebuild", () => {
    const document = `{
\tarchiveVersion = 1;
\tobjects = {
\t\t"ABCD1234EF567890" = {
\t\t\tisa = PBXFileReference;
\t\t\tpath = "Sources/App Delegate.swift";
\t\t\tsourceTree = "<group>";
\t\t};
\t};
\trootObject = ABCD1234EF567890;
}
`;
    const parsed = parseOpenStepPlist(document) as Record<string, PlistValue>;
    parsed["archiveVersion"] = "2";

    expect(parseOpenStepPlist(buildOpenStepPlist(parsed))).toEqual(parsed);
  });

  test("seeded random documents round-trip through both parse entry points", () => {
    // Deterministic LCG, so failures reproduce.
    let state = 0xbeef;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const randomString = () => {
      const alphabet = 'ab z09$/:.-="\\\n\t\u0007\u00e9\ud83d\ude00';
      let out = "";
      for (let i = 0, n = Math.floor(random() * 10); i < n; i++) {
        out += alphabet[Math.floor(random() * alphabet.length)];
      }
      return out;
    };
    const randomValue = (depth: number): PlistValue => {
      switch (Math.floor(random() * (depth > 2 ? 2 : 4))) {
        case 0:
          return randomString();
        case 1:
          return Uint8Array.from({ length: Math.floor(random() * 9) }, () => Math.floor(random() * 256));
        case 2:
          return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(depth + 1));
        default: {
          const dict: Record<string, PlistValue> = {};
          for (let i = 0, n = Math.floor(random() * 4); i < n; i++) {
            dict[randomString()] = randomValue(depth + 1);
          }
          return dict;
        }
      }
    };

    for (let i = 0; i < 200; i++) {
      const value = randomValue(0);
      const indented = buildOpenStepPlist(value);
      const singleLine = buildOpenStepPlist(value, { indent: false });

      expect(parseOpenStepPlist(indented), indented).toEqual(value);
      expect(parsePlist(singleLine), singleLine).toEqual(value);
    }
  });
});

describe.runIf(process.platform === "darwin")("plutil cross-validation", () => {
  test("plutil reads our output back to the same values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-osbuild-"));
    try {
      const value: PlistValue = {
        name: 'quote " backslash \\ tab\t',
        bell: "\u0007",
        loneSurrogate: "\ud83d",
        emoji: "café 😀",
        blob: new Uint8Array([0, 1, 2, 253, 254, 255]),
        list: ["bare", "needs quoting", ["nested"], new Uint8Array([9])],
        "quoted key": "value",
      };

      const path = join(dir, "doc.plist");
      const binPath = join(dir, "doc.bin");
      await writeFile(path, buildOpenStepPlist(value));
      await execFileAsync("plutil", ["-convert", "binary1", "-o", binPath, path]);

      expect(parseBinaryPlist(new Uint8Array(await readFile(binPath)))).toEqual(value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
