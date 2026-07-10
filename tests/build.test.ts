import { buildPlist, parsePlist, PlistBuildError, PlistUid, type PlistValue } from "../src/index";

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

test("emits the reference writer layout for a nested document", () => {
  const xml = buildPlist({
    name: "Rork",
    count: 42,
    items: ["a", true],
    payload: new Uint8Array([1, 2, 254]),
  });

  expect(xml).toBe(
    `${HEADER}<plist version="1.0">
<dict>
\t<key>name</key>
\t<string>Rork</string>
\t<key>count</key>
\t<integer>42</integer>
\t<key>items</key>
\t<array>
\t\t<string>a</string>
\t\t<true/>
\t</array>
\t<key>payload</key>
\t<data>AQL+</data>
</dict>
</plist>
`,
  );
});

test("emits a single-line body when indent is disabled", () => {
  const xml = buildPlist({ a: [1] }, { indent: false });

  expect(xml).toBe(
    `${HEADER}<plist version="1.0"><dict><key>a</key><array><integer>1</integer></array></dict></plist>\n`,
  );
});

test("supports a custom indentation unit", () => {
  const xml = buildPlist({ a: 1 }, { indent: "  " });

  expect(xml).toContain("\n<dict>\n  <key>a</key>\n  <integer>1</integer>\n</dict>\n");
});

test("emits the empty-element forms the reference parser accepts", () => {
  const xml = buildPlist(
    {
      dict: {},
      array: [],
      string: "",
      data: new Uint8Array(0),
    },
    { indent: false },
  );

  // <data></data> is load-bearing because the reference parser rejects <data/>.
  expect(xml).toContain("<dict/>");
  expect(xml).toContain("<array/>");
  expect(xml).toContain("<string></string>");
  expect(xml).toContain("<data></data>");
});

describe("strings", () => {
  test("escapes markup characters and carriage returns", () => {
    const xml = buildPlist("a&b<c>d\re\tf\ng", { indent: false });

    expect(xml).toContain("<string>a&amp;b&lt;c&gt;d&#13;e\tf\ng</string>");
  });

  test("passes astral pairs through and rejects lone surrogates", () => {
    expect(buildPlist("😀", { indent: false })).toContain("<string>😀</string>");
    expect(() => buildPlist("\uD800")).toThrow(PlistBuildError);
    expect(() => buildPlist("a\uDC00b")).toThrow(PlistBuildError);
  });

  test("rejects control characters that XML cannot represent", () => {
    expect(() => buildPlist("a\u0000b")).toThrow(PlistBuildError);
    expect(() => buildPlist({ key: "\u0001" })).toThrow("at $.key");
  });
});

describe("numbers", () => {
  test("writes integral numbers as integers and fractions as reals", () => {
    const xml = buildPlist([42, -7, 0.5, -0], { indent: false });

    expect(xml).toContain("<integer>42</integer><integer>-7</integer><real>0.5</real><integer>0</integer>");
  });

  test("writes bigints as integers", () => {
    expect(buildPlist(18446744073709551615n, { indent: false })).toContain("<integer>18446744073709551615</integer>");
  });

  test("rejects bigints outside the 64-bit range", () => {
    expect(() => buildPlist(18446744073709551616n)).toThrow(PlistBuildError);
    expect(() => buildPlist(-9223372036854775809n)).toThrow(PlistBuildError);
  });

  test("rejects integral numbers outside the 64-bit range", () => {
    // Integer-valued doubles skip the bigint path but must not silently emit
    // exponential notation (`1e+40`) that the <integer> grammar cannot carry.
    expect(() => buildPlist(1e40)).toThrow(PlistBuildError);
    expect(() => buildPlist(-1e19)).toThrow(PlistBuildError);
  });

  test("rejects NaN and infinities", () => {
    expect(() => buildPlist(NaN)).toThrow(PlistBuildError);
    expect(() => buildPlist(Infinity)).toThrow(PlistBuildError);
  });
});

describe("dates", () => {
  test("writes second-precision UTC dates", () => {
    const xml = buildPlist(new Date("2026-07-04T10:20:30.987Z"), { indent: false });

    expect(xml).toContain("<date>2026-07-04T10:20:30Z</date>");
  });

  test("rejects invalid dates", () => {
    expect(() => buildPlist(new Date(NaN))).toThrow(PlistBuildError);
  });

  test("rejects dates outside the four-digit year range", () => {
    // toISOString renders these in the expanded +YYYYYY form, which the
    // <date> layout cannot carry.
    const tenThousand = new Date(0);
    tenThousand.setUTCFullYear(10_000, 0, 1);
    const negative = new Date(0);
    negative.setUTCFullYear(-1, 0, 1);

    expect(() => buildPlist(tenThousand)).toThrow(PlistBuildError);
    expect(() => buildPlist(negative)).toThrow(PlistBuildError);
  });

  test("round-trips early four-digit years", () => {
    const early = new Date(0);
    early.setUTCFullYear(50, 0, 1);
    early.setUTCHours(0, 0, 0, 0);

    expect(buildPlist(early, { indent: false })).toContain("<date>0050-01-01T00:00:00Z</date>");
  });
});

describe("binary data", () => {
  test("encodes exactly the view's window, not its backing buffer", () => {
    // Protocol code routinely passes subarray views into larger buffers; the
    // serialized bytes must cover only the view's slice.
    const backing = new Uint8Array([0, 0, 1, 2, 254, 0, 0]);
    const view = backing.subarray(2, 5);

    expect(buildPlist(view, { indent: false })).toContain("<data>AQL+</data>");
  });

  test("accepts other ArrayBuffer views at runtime", () => {
    // The static contract is Uint8Array; any other view is tolerated at
    // runtime and serialized as the raw bytes of its window.
    const bytes = new Uint8Array([1, 2, 254]);
    const view = new DataView(bytes.buffer) as unknown as PlistValue;

    expect(buildPlist(view, { indent: false })).toContain("<data>AQL+</data>");
  });
});

describe("undefined omission", () => {
  // `PlistValue` forbids undefined values, so these mirror a loosely typed
  // caller (a JSON-API object, an index-signature read) reaching the builder.
  test("drops dictionary keys whose value is undefined, like JSON.stringify", () => {
    const xml = buildPlist({ kept: "yes", dropped: undefined, also: 1 } as never, { indent: false });

    expect(xml).toContain("<key>kept</key><string>yes</string>");
    expect(xml).toContain("<key>also</key><integer>1</integer>");
    expect(xml).not.toContain("dropped");
  });

  test("collapses a dictionary of only undefined values to an empty dict", () => {
    expect(buildPlist({ a: undefined, b: undefined } as never, { indent: false })).toContain("<dict/>");
  });

  test("omits undefined in nested dictionaries", () => {
    const xml = buildPlist({ outer: { keep: true, drop: undefined } } as never, { indent: false });

    expect(xml).toContain("<key>keep</key><true/>");
    expect(xml).not.toContain("drop");
  });

  test("round-trips a dictionary with an undefined value as the omitted shape", () => {
    expect(parsePlist(buildPlist({ present: 42, absent: undefined } as never))).toEqual({ present: 42 });
  });

  test("rejects undefined array elements instead of shifting indices", () => {
    // Unlike a dictionary key, dropping an array element would silently
    // renumber everything after it, so undefined in an array is an error.
    expect(() => buildPlist([1, undefined, 3] as never)).toThrow("at $[1]");
  });

  test("rejects undefined at the document root", () => {
    expect(() => buildPlist(undefined as never)).toThrow("at $");
  });
});

describe("unrepresentable values", () => {
  test("rejects null with the value path, including inside arrays", () => {
    expect(() => buildPlist({ outer: [null] } as never)).toThrow("at $.outer[0]");
    expect(() => buildPlist(null as never)).toThrow("at $");
  });

  test("rejects class instances", () => {
    expect(() => buildPlist(new Map() as never)).toThrow(PlistBuildError);
  });

  test("accepts null-prototype objects as dictionaries", () => {
    const dict = Object.create(null) as Record<string, string>;
    dict.a = "x";

    expect(buildPlist(dict, { indent: false })).toContain("<dict><key>a</key><string>x</string></dict>");
  });
});

describe("keyed-archive UIDs", () => {
  test("writes a UID as the platform's CF$UID dictionary shape", () => {
    expect(buildPlist(new PlistUid(7), { indent: false })).toContain(
      "<dict><key>CF$UID</key><integer>7</integer></dict>",
    );
  });

  test("round-trips UIDs losslessly", () => {
    const value: PlistValue = { root: new PlistUid(1), objects: [new PlistUid(0), new PlistUid(4294967295)] };

    expect(parsePlist(buildPlist(value))).toEqual(value);
  });

  test("rejects indexes a UID cannot hold", () => {
    expect(() => new PlistUid(-1)).toThrow(RangeError);
    expect(() => new PlistUid(2 ** 32)).toThrow(RangeError);
    expect(() => new PlistUid(1.5)).toThrow(RangeError);
    expect(() => new PlistUid(Number.NaN)).toThrow(RangeError);
  });
});
