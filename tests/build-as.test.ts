import { buildPlistAs, detectPlistFormat, parsePlist, parsePlistDictionary } from "../src/index";

test("builds each format and parses back to the same value", () => {
  const value = { name: "Rork", count: 42, enabled: true };

  const binary = buildPlistAs(value, "binary");
  expect(binary).toBeInstanceOf(Uint8Array);
  expect(parsePlist(binary)).toEqual(value);

  const xml = buildPlistAs(value, "xml");
  expect(xml).toContain("<plist");
  expect(parsePlist(xml)).toEqual(value);

  // OpenStep is untyped and accepts only its own value model, so the
  // dispatcher must surface the format's stricter rules unchanged.
  const untyped = { name: "Rork" };
  const openstep = buildPlistAs(untyped, "openstep");
  expect(openstep).toContain("=");
  expect(parsePlist(openstep)).toEqual(untyped);
  expect(() => buildPlistAs(value, "openstep")).toThrow(/no OpenStep representation/u);
});

test("rejects unknown formats for callers outside the type system", () => {
  const format = "yaml" as unknown as "xml";

  expect(() => buildPlistAs({ a: "b" }, format)).toThrow(/unknown property list format "yaml"/u);
});

test("rebuilds a document in its detected source format", () => {
  // The composition this entry point exists for. A binary source must come
  // back binary after a read-modify-write pass, never silently as XML.
  const source = buildPlistAs({ CFBundleIdentifier: "com.example.original" }, "binary");

  const info = parsePlistDictionary(source);
  info["CFBundleIdentifier"] = "com.example.rebranded";
  const rebuilt = buildPlistAs(info, detectPlistFormat(source));

  expect(detectPlistFormat(rebuilt)).toBe("binary");
  expect(parsePlistDictionary(rebuilt)).toEqual({ CFBundleIdentifier: "com.example.rebranded" });
});
