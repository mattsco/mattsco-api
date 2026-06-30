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

### Autres routes
Quelques routes à usage strictement personnel (données privées récupérées via des
tokens stockés en variables d'environnement). Non documentées ici.

Protégées par un secret partagé : si la variable d'env `API_SECRET` est définie, ces
routes exigent `?k=<secret>` et renvoient sinon un `404`. Pour protéger une route,
ajouter en tête du handler :

```js
const SECRET = process.env.API_SECRET;
if (SECRET && (!req.query || req.query.k !== SECRET)) { res.status(404).end(); return; }
```

## Déploiement
Voir [`DEPLOY.md`](./DEPLOY.md).

## Ajouter une route
Créer `api/<nom>.js` (`export default async function handler(req, res)`) puis
`npx vercel --prod`. Toutes les routes partagent les variables d'env du projet.

## Client
La montre Garmin associée (widget Connect IQ) vit dans un projet séparé
(`garmin_RER_A`) et n'appelle que `/api/rer`.
