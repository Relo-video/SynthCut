import { customAlphabet } from "nanoid";

// URL/filename-safe, human-readable-ish ids.
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const make = customAlphabet(alphabet, 10);

export function newId(prefix: string): string {
  return `${prefix}_${make()}`;
}
