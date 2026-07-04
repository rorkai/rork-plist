import { buildPlist, PlistBuildError, type PlistValue } from "../src/index";

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

  // <data></data> is load-bearing: the reference parser rejects <data/>.
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

describe("unrepresentable values", () => {
  test("rejects null and undefined with the value path", () => {
    expect(() => buildPlist({ outer: [null] } as never)).toThrow("at $.outer[0]");
    expect(() => buildPlist(undefined as never)).toThrow("at $");
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
