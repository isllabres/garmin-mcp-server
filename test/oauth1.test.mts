// Valida la firma OAuth1 contra el vector de test publico de Twitter,
// que es el ejemplo canonico de HMAC-SHA1 en OAuth 1.0a.
import { pct, hmacSha1 } from "../src/garmin.ts";

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FALLO"}  ${name}`);
  if (!ok) { console.log(`        obtenido: ${got}\n        esperado: ${want}`); fail++; }
};

// --- 1. percent-encoding RFC 3986 ---
check("pct: espacio",        pct("Hello Ladies"), "Hello%20Ladies");
check("pct: reservados",     pct("a+b c!*'()"),   "a%2Bb%20c%21%2A%27%28%29");
check("pct: no-reservados",  pct("aZ09-._~"),     "aZ09-._~");

// --- 2. firma contra el vector de Twitter ---
const params: Record<string,string> = {
  include_entities: "true",
  oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
  oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "1318622958",
  oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  oauth_version: "1.0",
  status: "Hello Ladies + Gentlemen, a signed OAuth request!",
};
const url = "https://api.twitter.com/1/statuses/update.json";

// Misma construccion que usa exchange() en garmin.ts
const normalized = Object.keys(params).sort()
  .map(k => `${pct(k)}=${pct(params[k])}`).join("&");
const base = `POST&${pct(url)}&${pct(normalized)}`;

const WANT_BASE = "POST&https%3A%2F%2Fapi.twitter.com%2F1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521";
check("base string", base, WANT_BASE);

const signingKey = `${pct("kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw")}&${pct("LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE")}`;
check("firma HMAC-SHA1", await hmacSha1(signingKey, base), "tnnArxj06cWHq44gCs1OSKk/jLY=");

console.log(fail ? `\n${fail} FALLO(S)` : "\nTodo correcto.");
process.exit(fail ? 1 : 0);
