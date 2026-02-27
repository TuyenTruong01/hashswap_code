import { CONFIG } from "./config.js";

export async function mirrorGet(path) {
  const url = `${CONFIG.mirrorNode}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mirror GET failed ${res.status}: ${text}`);
  }
  return res.json();
}