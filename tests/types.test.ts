import { isPlistDictionary, parsePlist, PlistUid } from "../src/index";

test("narrows a parsed document root to a dictionary", () => {
  const value = parsePlist('<plist version="1.0"><dict><key>name</key><string>Rork</string></dict></plist>');

  expect(isPlistDictionary(value)).toBe(true);
  assert(isPlistDictionary(value));
  expect(value["name"]).toBe("Rork");
});

test("accepts an empty dictionary", () => {
  expect(isPlistDictionary({})).toBe(true);
});

test("rejects every non-dictionary value shape", () => {
  expect(isPlistDictionary("text")).toBe(false);
  expect(isPlistDictionary(42)).toBe(false);
  expect(isPlistDictionary(42n)).toBe(false);
  expect(isPlistDictionary(true)).toBe(false);
  expect(isPlistDictionary(new Date(0))).toBe(false);
  expect(isPlistDictionary(new Uint8Array([1, 2]))).toBe(false);
  expect(isPlistDictionary([])).toBe(false);
  expect(isPlistDictionary(new PlistUid(7))).toBe(false);
  expect(isPlistDictionary(null)).toBe(false);
});

test("narrows an absent dictionary member without a presence check", () => {
  const value = parsePlist("<dict/>");
  assert(isPlistDictionary(value));

  expect(isPlistDictionary(value["missing"])).toBe(false);
});

test("rejects the keyed-archive UID a one-key CF$UID dictionary parses into", () => {
  // The canonical CF$UID shape parses as a PlistUid object, not as the
  // dictionary that encodes it, so a guard that only rules out arrays,
  // buffers, and dates would misclassify it.
  const value = parsePlist("<dict><key>CF$UID</key><integer>3</integer></dict>");

  expect(value).toBeInstanceOf(PlistUid);
  expect(isPlistDictionary(value)).toBe(false);
});
