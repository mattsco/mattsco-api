# mattsco-api

Petit projet d'API serverless (Vercel) regroupant des routes utilitaires perso
sous `/api/*`. Déployé sur Vercel ; les secrets vivent en variables d'environnement.

## Routes

### `GET /api/rer`
Prochains départs du RER A à **Rueil-Malmaison → Paris**, en temps réel.

Appelle l'API PRIM (Île-de-France Mobilités), filtre la direction Paris, et renvoie
un mini-JSON destiné à une montre Garmin (qui ne peut pas avaler la réponse SIRI
brute de ~58 Ko) :

```json
{ "deps": [ { "t": 1751280300, "dest": "Marne-Vallee" }, ... ] }
```

`t` = heure de départ en epoch UTC (secondes). Le client calcule le compte à rebours.

Variable d'env requise : `PRIM_KEY` (clé marketplace PRIM).

### `GET /api/oura`
Tes métriques Oura "daily". Token Oura (**Personal Access Token**) en env `OURA_TOKEN`.

Interroge toutes les routes `daily_*` : `sleep`, `readiness`, `activity`, `spo2`,
`stress`, `resilience`, `cardiovascular_age`. Celles que le token n'autorise pas sont
ignorées et listées dans `_unavailable`.

- `GET /api/oura` → **dernier enregistrement COMPLET par métrique** (score +
  `contributors` + `timestamp` + tout ce que l'API renvoie). Dates possiblement
  différentes car l'activité du jour n'est consolidée qu'en fin de journée :
  ```json
  {
    "sleep": {
      "day": "2026-06-30", "score": 70,
      "contributors": { "deep_sleep": 89, "efficiency": 81, "rem_sleep": 48, ... },
      "timestamp": "2026-06-30T00:00:00.000+00:00"
    },
    "readiness": { "day": "2026-06-30", "score": 80, "contributors": { ... } },
    "activity":  { "day": "2026-06-29", "score": 88, "contributors": { ... } }
  }
  ```
- `GET /api/oura?days=7` → tableaux bruts par métrique (récent d'abord) :
  `{ "sleep": [ {...}, ... ], "readiness": [ ... ], ... }`

Variable d'env requise : `OURA_TOKEN`
(créer le token sur https://cloud.ouraring.com/personal-access-tokens).

## Déploiement
Voir [`DEPLOY.md`](./DEPLOY.md).

## Ajouter une route
Créer `api/<nom>.js` (`export default async function handler(req, res)`) puis
`npx vercel --prod`. Toutes les routes partagent les variables d'env du projet.

## Client
La montre Garmin associée (widget Connect IQ) vit dans un projet séparé
(`garmin_RER_A`) et n'appelle que `/api/rer`.
