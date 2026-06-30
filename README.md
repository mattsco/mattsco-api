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

## Déploiement
Voir [`DEPLOY.md`](./DEPLOY.md).

## Ajouter une route
Créer `api/<nom>.js` (`export default async function handler(req, res)`) puis
`npx vercel --prod`. Toutes les routes partagent les variables d'env du projet.

## Client
La montre Garmin associée (widget Connect IQ) vit dans un projet séparé
(`garmin_RER_A`) et n'appelle que `/api/rer`.
