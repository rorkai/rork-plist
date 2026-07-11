import { parsePlist, parseXmlPlist, PlistParseError } from "../src/index";

test("parses XML documents identically to the generic entry", () => {
  const xml = '<plist version="1.0"><dict><key>name</key><string>Rork</string></dict></plist>';

  expect(parseXmlPlist(xml)).toEqual(parsePlist(xml));
});

test("never falls back to the OpenStep grammar", () => {
  // The generic entry reads markup-shaped data literals the way the
  // platform tooling does; the strict entry reports the XML error instead.
  expect(parsePlist("<0fbd77>")).toEqual(new Uint8Array([0x0f, 0xbd, 0x77]));
  expect(() => parseXmlPlist("<0fbd77>")).toThrow(PlistParseError);
  expect(() => parseXmlPlist("{ a = 1; }")).toThrow(PlistParseError);
});

test("forwards parse options", () => {
  expect(() => parseXmlPlist("<array><array/></array>", { maxDepth: 1 })).toThrow(/maximum nesting depth/u);
});
