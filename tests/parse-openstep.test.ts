import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseBinaryPlist, parseOpenStepPlist, parsePlist, PlistParseError, type PlistValue } from "../src/index";

const execFileAsync = promisify(execFile);

// Every case in this file mirrors a plutil probe; the expected values are
// what the platform parser produced for the same text.

describe("dictionaries", () => {
  test("parses braced entries with quoted and bare strings", () => {
    expect(parseOpenStepPlist('{ a = 1; "b c" = "d e"; }')).toEqual({ a: "1", "b c": "d e" });
    expect(parseOpenStepPlist("{a=b;}")).toEqual({ a: "b" });
  });

  test("requires the entry semicolon, including before the closing brace", () => {
    expect(() => parseOpenStepPlist("{ a = 1 }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = { b = c; } }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = 1;; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = 1, b = 2; }")).toThrow(PlistParseError);
  });

  test("supports the bare-key shorthand whose value is the key", () => {
    expect(parseOpenStepPlist('{ "key"; }')).toEqual({ key: "key" });
    expect(parseOpenStepPlist("{ key; }")).toEqual({ key: "key" });
  });

  test("resolves duplicate keys to the last occurrence", () => {
    expect(parseOpenStepPlist("{ a = 1; a = 2; }")).toEqual({ a: "2" });
  });

  test("rejects non-string keys and empty values", () => {
    expect(() => parseOpenStepPlist("{ <01> = a; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ (a) = b; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = ; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ = a; }")).toThrow(PlistParseError);
  });

  test("keeps a literal __proto__ key an own property", () => {
    const parsed = parseOpenStepPlist("{ __proto__ = x; }") as Record<string, unknown>;

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed["__proto__"]).toBe("x");
  });
});

describe("strings files", () => {
  test("parses brace-less documents as dictionaries", () => {
    expect(parseOpenStepPlist('"a" = "b";\n"c" = "d";')).toEqual({ a: "b", c: "d" });
    expect(parseOpenStepPlist('a = 1; "b" = 2;')).toEqual({ a: "1", b: "2" });
  });

  test("parses bare-key entries, while a lone string stays a string", () => {
    expect(parseOpenStepPlist('"key";')).toEqual({ key: "key" });
    expect(parseOpenStepPlist("key;")).toEqual({ key: "key" });
    expect(parseOpenStepPlist('"key"')).toBe("key");
  });

  test("parses whitespace or comments only as an empty dictionary", () => {
    expect(parseOpenStepPlist("  \n\t ")).toEqual({});
    expect(parseOpenStepPlist("// nothing\n")).toEqual({});
  });

  test("rejects empty input", () => {
    expect(() => parseOpenStepPlist("")).toThrow(PlistParseError);
  });
});

describe("arrays", () => {
  test("parses comma-separated elements with an optional trailing comma", () => {
    expect(parseOpenStepPlist("(1, 2, 3)")).toEqual(["1", "2", "3"]);
    expect(parseOpenStepPlist("(1, 2,)")).toEqual(["1", "2"]);
    expect(parseOpenStepPlist("()")).toEqual([]);
    expect(parseOpenStepPlist("({a=1;},{b=2;})")).toEqual([{ a: "1" }, { b: "2" }]);
  });

  test("rejects missing or leading separators", () => {
    expect(() => parseOpenStepPlist("(a b)")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("(,a)")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("(1; 2)")).toThrow(PlistParseError);
  });
});

describe("data", () => {
  test("parses hex bytes with whitespace-separated even groups", () => {
    expect(parseOpenStepPlist("<0102fe>")).toEqual(new Uint8Array([1, 2, 254]));
    expect(parseOpenStepPlist("<01 02 FE>")).toEqual(new Uint8Array([1, 2, 254]));
    expect(parseOpenStepPlist("<>")).toEqual(new Uint8Array(0));
    expect(parseOpenStepPlist("< >")).toEqual(new Uint8Array(0));
  });

  test("rejects odd digit groups and unterminated literals", () => {
    expect(() => parseOpenStepPlist("<012>")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("<0 102>")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("<01")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("<01 /*x*/ 02>")).toThrow(PlistParseError);
  });

  test("separates groups with the reference parser's data whitespace only", () => {
    // Between tokens, vertical tab and form feed are legal separators; inside
    // a data literal the reference parser rejects them.
    expect(parseOpenStepPlist("<01\t02\r\n03>")).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => parseOpenStepPlist("<01\u000b02>")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("<01\f02>")).toThrow(PlistParseError);
    expect(parseOpenStepPlist("{ a =\f<0102>; }")).toEqual({ a: new Uint8Array([1, 2]) });
  });
});

describe("strings and escapes", () => {
  test("parses single- and double-quoted strings", () => {
    expect(parseOpenStepPlist('"a b"')).toBe("a b");
    expect(parseOpenStepPlist("'a\"b'")).toBe('a"b');
    expect(parseOpenStepPlist('""')).toBe("");
  });

  test("resolves the C escape set", () => {
    expect(parseOpenStepPlist('"a\\nb\\tc"')).toBe("a\nb\tc");
    expect(parseOpenStepPlist('"\\a\\b\\f\\r\\v"')).toBe("\u0007\b\f\r\v");
  });

  test("any other escaped character stands for itself", () => {
    expect(parseOpenStepPlist('"a\\"b"')).toBe('a"b');
    expect(parseOpenStepPlist('"a\\\\b"')).toBe("a\\b");
    expect(parseOpenStepPlist('"\\q\\8"')).toBe("q8");
    expect(parseOpenStepPlist('"a\\\nb"')).toBe("a\nb");
  });

  test("maps octal escapes through the NeXTSTEP encoding", () => {
    expect(parseOpenStepPlist('"\\101"')).toBe("A");
    expect(parseOpenStepPlist('"\\7"')).toBe("\u0007");
    expect(parseOpenStepPlist('"\\1019"')).toBe("A9");
    // 0xE1 in the NeXTSTEP character set is Æ, not Latin-1 á.
    expect(parseOpenStepPlist('"\\341"')).toBe("\u00C6");
    expect(parseOpenStepPlist('"\\200"')).toBe("\u00A0");
    // Values beyond three octal digits' byte range wrap to a byte first.
    expect(parseOpenStepPlist('"\\501"')).toBe("A");
  });

  test("reads \\U escapes as raw UTF-16 code units", () => {
    expect(parseOpenStepPlist('"\\U0041"')).toBe("A");
    expect(parseOpenStepPlist('"\\U41"')).toBe("A");
    expect(parseOpenStepPlist('"\\U00419"')).toBe("A9");
    expect(parseOpenStepPlist('"\\Ud83d\\Ude00"')).toBe("😀");
    expect(parseOpenStepPlist('"\\Ud83d"')).toBe("\uD83D");
    expect(parseOpenStepPlist('"\\U"')).toBe("\u0000");
    // Lowercase \u is not a Unicode escape; the u stands for itself.
    expect(parseOpenStepPlist('"\\u0041"')).toBe("u0041");
  });

  test("rejects unterminated strings", () => {
    expect(() => parseOpenStepPlist('"abc')).toThrow(PlistParseError);
  });
});

describe("bare strings", () => {
  test("accepts the reference parser's token alphabet", () => {
    expect(parseOpenStepPlist("{ a-b.c_d$e = /usr/bin; }")).toEqual({ "a-b.c_d$e": "/usr/bin" });
    expect(parseOpenStepPlist("{ a:b = c:d; }")).toEqual({ "a:b": "c:d" });
    expect(parseOpenStepPlist("{ a = x//y; }")).toEqual({ a: "x//y" });
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => parseOpenStepPlist("{ a = b+c; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = b@c; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = café; }")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = b\\nc; }")).toThrow(PlistParseError);
  });
});

describe("comments and layout", () => {
  test("skips line and block comments between tokens", () => {
    expect(parseOpenStepPlist("// hi\n{ a = /* x */ 1; }")).toEqual({ a: "1" });
    expect(parseOpenStepPlist("{ a /*c*/ = b; }")).toEqual({ a: "b" });
    expect(parseOpenStepPlist('// c\n"a" = "b"; // d\n')).toEqual({ a: "b" });
  });

  test("comments do not nest and may run to the end of input", () => {
    expect(parseOpenStepPlist("{ a = /* x /* y */ 1; }")).toEqual({ a: "1" });
    expect(parseOpenStepPlist("{ a = 1; } /*")).toEqual({ a: "1" });
    expect(parseOpenStepPlist("{ a = 1; } // x")).toEqual({ a: "1" });
  });

  test("a comment does not start inside a bare token", () => {
    expect(() => parseOpenStepPlist("{ a = x/*y*/; }")).toThrow(PlistParseError);
  });

  test("accepts CR, CRLF, and a leading byte order mark", () => {
    expect(parseOpenStepPlist("{ a = 1;\r b = 2;\r }")).toEqual({ a: "1", b: "2" });
    expect(parseOpenStepPlist("\uFEFF{ a = 1; }")).toEqual({ a: "1" });
  });

  test("rejects content after the root value", () => {
    expect(() => parseOpenStepPlist("{ a = 1; } x")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist("{ a = 1; };")).toThrow(PlistParseError);
    expect(() => parseOpenStepPlist('"a" "b"')).toThrow(PlistParseError);
  });

  test("enforces the nesting depth limit, empty containers included", () => {
    expect(() => parseOpenStepPlist("((((x))))", { maxDepth: 2 })).toThrow(/maximum nesting depth/u);
    // The limit applies on container entry, so an empty container one level
    // past the limit fails exactly like a populated one.
    expect(() => parseOpenStepPlist("({};)", { maxDepth: 1 })).toThrow(/maximum nesting depth/u);
    expect(() => parseOpenStepPlist("(())", { maxDepth: 1 })).toThrow(/maximum nesting depth/u);
    expect(parseOpenStepPlist("(())", { maxDepth: 2 })).toEqual([[]]);
  });

  test("rejects GNUstep typed values, like the reference parser", () => {
    expect(() => parseOpenStepPlist("{ a = <*I5>; }")).toThrow(PlistParseError);
  });
});

describe("parsePlist dispatch", () => {
  test("routes non-markup text to the OpenStep grammar", () => {
    expect(parsePlist("{ a = 1; }")).toEqual({ a: "1" });
    expect(parsePlist("hello")).toBe("hello");
    expect(parsePlist('"a" = "b";')).toEqual({ a: "b" });
    expect(parsePlist(new TextEncoder().encode("{ a = <0102>; }"))).toEqual({ a: new Uint8Array([1, 2]) });
  });

  test("reads angle-bracket roots the way the platform does", () => {
    // <dada> is hex data to the reference parser, not an XML tag.
    expect(parsePlist("<dada>")).toEqual(new Uint8Array([0xda, 0xda]));
    expect(parsePlist("<0102fe>")).toEqual(new Uint8Array([1, 2, 254]));
    // <data>...</data> is XML markup, so 't' never parses as hex.
    expect(parsePlist("<data>AQL+</data>")).toEqual(new Uint8Array([1, 2, 254]));
  });

  test("keeps reporting the XML error for markup-shaped input", () => {
    expect(() => parsePlist("<dict><key>a</key></dict>")).toThrow(/value missing for key/u);
    expect(() => parsePlist("<widget>1</widget>")).toThrow(PlistParseError);
  });

  test("still parses XML strings and buffers unchanged", () => {
    expect(parsePlist("<string>x</string>")).toBe("x");
    expect(parsePlist('<plist version="1.0"><true/></plist>')).toBe(true);
  });
});

describe.runIf(process.platform === "darwin")("plutil OpenStep cross-validation", () => {
  /** Parses `text` with plutil by converting to binary, as ground truth. */
  async function plutilParse(dir: string, text: string): Promise<PlistValue> {
    const source = join(dir, "doc.plist");
    const binary = join(dir, "doc.bin");
    await writeFile(source, text);
    await execFileAsync("plutil", ["-convert", "binary1", "-o", binary, source]);
    return parseBinaryPlist(new Uint8Array(await readFile(binary)));
  }

  test("agrees with plutil across a document exercising the whole grammar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-os-"));
    try {
      const document = `// header comment
      {
        name = "R\\U00f8rk \\Ud83d\\Ude00";
        path = /usr/local/bin;
        version = 1.2.3;
        "quoted key" = 'single quoted';
        octal = "\\101\\341\\200";
        escapes = "a\\tb\\nc\\"d\\\\e";
        blob = <0fbd 77AB cd>;
        empty = <>;
        list = (one, "two three", <ff00>, { nested = yes; }, ());
        strings /* inline */ = { "key"; bare; };
      }`;

      expect(parseOpenStepPlist(document)).toEqual(await plutilParse(dir, document));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("agrees with plutil on seeded random documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-os-fuzz-"));
    try {
      // Deterministic LCG, so failures reproduce.
      let state = 0xc0ffee;
      const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
      const bareAlphabet = "abcXYZ019_$/:.-";
      const randomBare = () => {
        let out = "";
        for (let i = 0, n = 1 + Math.floor(random() * 8); i < n; i++) {
          out += bareAlphabet[Math.floor(random() * bareAlphabet.length)];
        }
        return out;
      };
      const randomQuoted = () => {
        const inner = randomBare() + (random() < 0.5 ? " \\t" : "\\U00e9 \\341");
        return `"${inner}"`;
      };
      const randomText = (depth: number): string => {
        const choice = Math.floor(random() * (depth > 2 ? 3 : 5));
        switch (choice) {
          case 0:
            return randomBare();
          case 1:
            return randomQuoted();
          case 2: {
            let hex = "";
            for (let i = 0, n = Math.floor(random() * 6); i < n; i++) {
              hex += Math.floor(random() * 256)
                .toString(16)
                .padStart(2, "0");
            }
            return `<${hex}>`;
          }
          case 3: {
            const items = Array.from({ length: Math.floor(random() * 4) }, () => randomText(depth + 1));
            return `(${items.join(", ")})`;
          }
          default: {
            const entries = Array.from(
              { length: Math.floor(random() * 4) },
              () => `${randomBare()} = ${randomText(depth + 1)};`,
            );
            return `{ ${entries.join(" ")} }`;
          }
        }
      };

      for (let i = 0; i < 40; i++) {
        const document = randomText(0);
        expect(parseOpenStepPlist(document), document).toEqual(await plutilParse(dir, document));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
