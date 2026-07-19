#!/usr/bin/env node
// Outil one-shot : obtient le PREMIER refresh token Oura via le flux OAuth2
// (authorization code). Oura a supprimé les Personal Access Tokens — un refresh
// token ne s'obtient qu'en autorisant l'app une fois dans le navigateur.
//
// Usage :
//   1. Déclare le redirect URI http://localhost:8788/callback dans ton app Oura
//      (portail developer.ouraring.com → ton app → Redirect URIs).
//   2. export OURA_CID='<client_id>'  OURA_SECRET='<client_secret>'
//   3. node scripts/oura-oauth.mjs
//   4. Le navigateur s'ouvre → connecte-toi à Oura → « Allow ».
//   → les tokens sont écrits dans scripts/.oura-tokens.json (git-ignoré).
//
// Zéro dépendance (http/crypto/fetch natifs, Node ≥ 18). Rien n'est envoyé
// ailleurs que chez Oura ; le client_secret ne sort jamais de ta machine.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const CLIENT_ID = process.env.OURA_CID;
const CLIENT_SECRET = process.env.OURA_SECRET;
const PORT = Number(process.env.OURA_OAUTH_PORT || 8788);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
// Scopes v2 : de quoi lire tout ce que le proxy interroge (le scope `daily`
// couvre les endpoints daily_*, spo2/stress/resilience compris). Ajuste si besoin.
const SCOPE = "personal daily heartrate workout session";

const AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN = "https://api.ouraring.com/oauth/token";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Manque OURA_CID et/ou OURA_SECRET dans l'environnement.");
  console.error("   export OURA_CID='...'  OURA_SECRET='...'  puis relance.");
  process.exit(1);
}

const state = randomUUID();
const authUrl =
  `${AUTHORIZE}?` +
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  }).toString();

async function exchangeCode(code) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text}`);
  return JSON.parse(text);
}

const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} car.)` : "—");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("not found");
    return;
  }
  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      .end(`Erreur Oura : ${err} — ${url.searchParams.get("error_description") || ""}`);
    console.error(`\n❌ Oura a refusé : ${err} — ${url.searchParams.get("error_description") || ""}`);
    server.close();
    process.exit(1);
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch");
    console.error("\n❌ state ne correspond pas (CSRF) — relance.");
    server.close();
    process.exit(1);
  }
  const code = url.searchParams.get("code");
  try {
    const tokens = await exchangeCode(code);
    const out = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      obtained_at: new Date().toISOString(),
    };
    const dest = join(import.meta.dirname, ".oura-tokens.json");
    writeFileSync(dest, JSON.stringify(out, null, 2), { mode: 0o600 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end("<h2>✅ Autorisé. Tu peux fermer cet onglet et revenir au terminal.</h2>");
    console.log("\n✅ Tokens obtenus et enregistrés dans scripts/.oura-tokens.json");
    console.log(`   access_token  : ${mask(out.access_token)}  (expire dans ~${Math.round((out.expires_in || 0) / 3600)} h)`);
    console.log(`   refresh_token : ${mask(out.refresh_token)}`);
    console.log("\n⚠️  Ce refresh_token est à usage unique : c'est le proxy qui le fera tourner ensuite.");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`Échec de l'échange : ${e.message}`);
    console.error(`\n❌ Échange du code échoué : ${e.message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n🔑 Autorisation Oura — ouvre cette URL (le navigateur devrait s'ouvrir seul) :\n\n${authUrl}\n`);
  console.log("En attente du retour d'Oura sur " + REDIRECT_URI + " …");
  // Ouvre le navigateur (macOS `open`). Si ça n'ouvre rien, copie l'URL ci-dessus.
  spawn("open", [authUrl], { stdio: "ignore" }).on("error", () => {});
  setTimeout(() => {
    console.error("\n⏱️  Rien reçu après 5 min — relance le script.");
    process.exit(1);
  }, 5 * 60_000);
});
