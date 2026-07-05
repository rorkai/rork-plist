import { parsePlist, PlistParseError } from "../src/index";

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

test("parses a complete Apple-style document with every value type", () => {
  const xml = `${HEADER}<plist version="1.0">
<dict>
\t<key>name</key>
\t<string>Rork</string>
\t<key>count</key>
\t<integer>42</integer>
\t<key>ratio</key>
\t<real>0.5</real>
\t<key>enabled</key>
\t<true/>
\t<key>disabled</key>
\t<false/>
\t<key>created</key>
\t<date>2026-07-04T10:20:30Z</date>
\t<key>payload</key>
\t<data>AQL+</data>
\t<key>items</key>
\t<array>
\t\t<string>a</string>
\t\t<integer>1</integer>
\t</array>
\t<key>nested</key>
\t<dict>
\t\t<key>inner</key>
\t\t<string>value</string>
\t</dict>
</dict>
</plist>
`;

  expect(parsePlist(xml)).toEqual({
    name: "Rork",
    count: 42,
    ratio: 0.5,
    enabled: true,
    disabled: false,
    created: new Date("2026-07-04T10:20:30Z"),
    payload: new Uint8Array([1, 2, 254]),
    items: ["a", 1],
    nested: { inner: "value" },
  });
});

test("parses a bare root element without the plist wrapper", () => {
  expect(parsePlist("<dict><key>a</key><string>x</string></dict>")).toEqual({ a: "x" });
});

test("skips a byte order mark", () => {
  expect(parsePlist('\uFEFF<plist version="1.0"><string>bom</string></plist>')).toBe("bom");
});

test("skips comments between elements and before the root", () => {
  const xml =
    '<!--hello--><plist version="1.0"><dict><!--x--><key>a</key><!--y--><string>x</string><!--z--></dict></plist>';

  expect(parsePlist(xml)).toEqual({ a: "x" });
});

test("keeps document order and lets later duplicate keys win", () => {
  const parsed = parsePlist(
    "<dict><key>b</key><integer>1</integer><key>a</key><integer>2</integer><key>b</key><integer>3</integer></dict>",
  );

  expect(parsed).toEqual({ b: 3, a: 2 });
  expect(Object.keys(parsed as object)).toEqual(["b", "a"]);
});

test("assigns a literal __proto__ key as an own property", () => {
  const parsed = parsePlist("<dict><key>__proto__</key><dict><key>polluted</key><true/></dict></dict>");

  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.getOwnPropertyNames(parsed)).toContain("__proto__");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

describe("strings", () => {
  test("decodes predefined entities and character references", () => {
    expect(parsePlist("<string>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#128512;</string>")).toBe("&<>\"'AB😀");
  });

  test("inlines CDATA sections between text runs", () => {
    expect(parsePlist("<string>a<![CDATA[<b>&c]]>d</string>")).toBe("a<b>&cd");
  });

  test("preserves whitespace, tabs, and carriage returns exactly", () => {
    expect(parsePlist("<string> a\tb\rc\nd </string>")).toBe(" a\tb\rc\nd ");
  });

  test("parses self-closed and open-close empty strings", () => {
    expect(parsePlist("<string/>")).toBe("");
    expect(parsePlist("<string></string>")).toBe("");
  });

  test("parses a key element outside a dict as a string value", () => {
    expect(parsePlist("<array><key>a</key></array>")).toEqual(["a"]);
  });

  test("rejects unknown entities and bare ampersands", () => {
    expect(() => parsePlist("<string>&foo;</string>")).toThrow(PlistParseError);
    expect(() => parsePlist("<string>a & b</string>")).toThrow(PlistParseError);
  });

  test("rejects character references outside Unicode scalar values", () => {
    expect(() => parsePlist("<string>&#xD800;</string>")).toThrow(PlistParseError);
    expect(() => parsePlist("<string>&#1114112;</string>")).toThrow(PlistParseError);
  });
});

describe("integers", () => {
  test("parses decimal integers with optional sign", () => {
    expect(parsePlist("<integer>42</integer>")).toBe(42);
    expect(parsePlist("<integer>+42</integer>")).toBe(42);
    expect(parsePlist("<integer>-7</integer>")).toBe(-7);
  });

  test("parses hexadecimal integers", () => {
    expect(parsePlist("<integer>0x1F</integer>")).toBe(31);
    expect(parsePlist("<integer>-0x10</integer>")).toBe(-16);
  });

  test("returns bigint beyond Number.MAX_SAFE_INTEGER", () => {
    expect(parsePlist("<integer>9007199254740991</integer>")).toBe(9007199254740991);
    expect(parsePlist("<integer>9007199254740992</integer>")).toBe(9007199254740992n);
    expect(parsePlist("<integer>18446744073709551615</integer>")).toBe(18446744073709551615n);
    expect(parsePlist("<integer>-9223372036854775808</integer>")).toBe(-9223372036854775808n);
  });

  test("rejects integers outside the 64-bit range", () => {
    expect(() => parsePlist("<integer>18446744073709551616</integer>")).toThrow(PlistParseError);
    expect(() => parsePlist("<integer>-9223372036854775809</integer>")).toThrow(PlistParseError);
  });

  test("rejects empty, padded, or malformed integers", () => {
    expect(() => parsePlist("<integer/>")).toThrow(PlistParseError);
    expect(() => parsePlist("<integer></integer>")).toThrow(PlistParseError);
    expect(() => parsePlist("<integer> 42 </integer>")).toThrow(PlistParseError);
    expect(() => parsePlist("<integer>4x2</integer>")).toThrow(PlistParseError);
  });
});

describe("reals", () => {
  test("parses decimal notation", () => {
    expect(parsePlist("<real>1.5</real>")).toBe(1.5);
    expect(parsePlist("<real>.5</real>")).toBe(0.5);
    expect(parsePlist("<real>-2</real>")).toBe(-2);
    expect(parsePlist("<real>1e3</real>")).toBe(1000);
  });

  test("parses the reference parser's special spellings", () => {
    expect(parsePlist("<real>nan</real>")).toBeNaN();
    expect(parsePlist("<real>inf</real>")).toBe(Infinity);
    expect(parsePlist("<real>-infinity</real>")).toBe(-Infinity);
  });

  test("rejects empty or padded reals", () => {
    expect(() => parsePlist("<real/>")).toThrow(PlistParseError);
    expect(() => parsePlist("<real> 1.5 </real>")).toThrow(PlistParseError);
  });
});

describe("dates", () => {
  test("parses the second-precision UTC layout", () => {
    expect(parsePlist("<date>2026-07-04T10:20:30Z</date>")).toEqual(new Date(Date.UTC(2026, 6, 4, 10, 20, 30)));
  });

  test("rejects layouts the reference parser rejects", () => {
    expect(() => parsePlist("<date>2026-07-04T10:20:30</date>")).toThrow(PlistParseError);
    expect(() => parsePlist("<date>2026-07-04T10:20:30.500Z</date>")).toThrow(PlistParseError);
    expect(() => parsePlist("<date>2026-07-04T10:20:30+00:00</date>")).toThrow(PlistParseError);
  });

  test("rejects impossible calendar dates instead of rolling them over", () => {
    expect(() => parsePlist("<date>2026-02-31T10:20:30Z</date>")).toThrow(PlistParseError);
    expect(() => parsePlist("<date>2026-13-01T10:20:30Z</date>")).toThrow(PlistParseError);
    expect(() => parsePlist("<date>2026-07-04T24:00:00Z</date>")).toThrow(PlistParseError);
  });

  test("accepts leap-day dates", () => {
    expect(parsePlist("<date>2028-02-29T00:00:00Z</date>")).toEqual(new Date(Date.UTC(2028, 1, 29)));
  });

  test("preserves years 0000-0099 instead of remapping them to 1900-1999", () => {
    const parsed = parsePlist("<date>0050-01-01T00:00:00Z</date>");

    assert(parsed instanceof Date);
    expect(parsed.getUTCFullYear()).toBe(50);
  });
});

describe("data", () => {
  test("decodes base64 with interleaved whitespace and missing padding", () => {
    expect(parsePlist("<data>\n\tAQL+\n</data>")).toEqual(new Uint8Array([1, 2, 254]));
    expect(parsePlist("<data>AQL+AQ</data>")).toEqual(new Uint8Array([1, 2, 254, 1]));
  });

  test("parses empty data elements", () => {
    expect(parsePlist("<data/>")).toEqual(new Uint8Array(0));
    expect(parsePlist("<data></data>")).toEqual(new Uint8Array(0));
  });

  test("rejects corrupt base64 instead of truncating it", () => {
    // The reference parser silently decodes this to zero bytes; dropping a
    // payload without an error is the failure mode this library refuses.
    expect(() => parsePlist("<data>AQ!L</data>")).toThrow(PlistParseError);
  });
});

describe("structure errors", () => {
  test("rejects unknown and wrongly-cased elements", () => {
    expect(() => parsePlist("<widget>1</widget>")).toThrow(PlistParseError);
    expect(() => parsePlist("<DICT></DICT>")).toThrow(PlistParseError);
  });

  test("rejects stray text inside containers", () => {
    expect(() => parsePlist("<dict>zz<key>a</key><string>x</string></dict>")).toThrow(PlistParseError);
    expect(() => parsePlist("<array>zz</array>")).toThrow(PlistParseError);
  });

  test("rejects a key without a value", () => {
    expect(() => parsePlist("<dict><key>a</key></dict>")).toThrow(/value missing for key "a"/u);
  });

  test("rejects non-empty true and false elements", () => {
    expect(() => parsePlist("<true>x</true>")).toThrow(PlistParseError);
  });

  test("rejects a second root value", () => {
    expect(() => parsePlist('<plist version="1.0"><string>a</string><string>b</string></plist>')).toThrow(
      PlistParseError,
    );
  });

  test("rejects mismatched closing tags", () => {
    expect(() => parsePlist("<dict><key>a</key><string>x</string></array>")).toThrow(PlistParseError);
  });

  test("rejects unterminated documents", () => {
    expect(() => parsePlist("<dict><key>a</key><string>x")).toThrow(PlistParseError);
    expect(() => parsePlist("<string>never closed")).toThrow(PlistParseError);
    expect(() => parsePlist("<!-- unterminated")).toThrow(PlistParseError);
  });

  test("rejects an empty document", () => {
    expect(() => parsePlist("")).toThrow(PlistParseError);
    expect(() => parsePlist("   \n  ")).toThrow(PlistParseError);
  });
});

test("ignores attributes on any element", () => {
  expect(parsePlist("<dict foo=\"bar\"><key>a</key><string x='y'>v</string></dict>")).toEqual({ a: "v" });
});

test("accepts unquoted attribute values, which Apple ships and the reference parser reads", () => {
  // Found in the wild on shipped macOS system plists, spelled exactly like
  // this in the XML declaration, the DOCTYPE, and the plist element.
  const document =
    "<?xml version=1.0 encoding=UTF-8?>\n" +
    "<!DOCTYPE plist PUBLIC -//Apple//DTD PLIST 1.0//EN http://www.apple.com/DTDs/PropertyList-1.0.dtd>\n" +
    "<plist version=1.0>\n<dict><key>a</key><string>v</string></dict>\n</plist>";

  expect(parsePlist(document)).toEqual({ a: "v" });
  expect(parsePlist("<string foo=bar/>")).toBe("");
  expect(parsePlist("<string foo=bar>x</string>")).toBe("x");
});

test("ignores trailing content after the closing plist tag", () => {
  expect(parsePlist('<plist version="1.0"><string>x</string></plist>extra')).toBe("x");
});

test("stays linear when a reference sits deep in a text-dense document", () => {
  // Every string element decodes a text range. If range decoding scanned
  // ahead for '&' without remembering the answer, each of these ranges would
  // rescan to the lone reference at the end and the parse would go
  // quadratic — a shape real system plists hit at multiple megabytes. The
  // 5-second test timeout fails the run if that regresses.
  const doc = `<array>${"<string>x</string>".repeat(120_000)}<string>&amp;</string></array>`;
  const parsed = parsePlist(doc) as string[];

  expect(parsed).toHaveLength(120_001);
  expect(parsed.at(-1)).toBe("&");
});

test("enforces the nesting depth limit", () => {
  const deep = "<array>".repeat(600) + "</array>".repeat(600);

  expect(() => parsePlist(deep)).toThrow(/maximum nesting depth of 512/u);
  expect(parsePlist(deep, { maxDepth: 700 })).toBeDefined();
  expect(() => parsePlist("<array><array/></array>", { maxDepth: 1 })).toThrow(PlistParseError);
});

test("reports line and column positions in errors", () => {
  const xml = '<plist version="1.0">\n<dict>\n\t<key>a</key>\n\t<widget/>\n</dict>\n</plist>';

  try {
    parsePlist(xml);
    expect.unreachable("parse should have failed");
  } catch (error) {
    assert(error instanceof PlistParseError);
    expect(error.position.line).toBe(4);
    expect(error.position.column).toBe(2);
    expect(error.message).toContain("line 4");
  }
});
