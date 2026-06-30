# Déploiement de `mattsco-api` (à faire depuis ton Mac, une fois)

Projet Vercel générique qui hébergera plusieurs routes `/api/*`.
Première route : `/api/rer` (prochains RER A Rueil → Paris).

Mon environnement n'a pas accès à npm/Vercel, donc le déploiement se fait chez toi.
La clé PRIM n'est PAS dans le code : elle se met en variable d'env Vercel.

```bash
cd /Users/mattsco/garmin/mattsco-api

# 1) Connexion + création du projet (nomme-le "mattsco-api" ; accepte les défauts)
npx vercel link

# 2) Injecter la clé PRIM en variable d'env (colle la valeur quand demandé,
#    environnement "Production")
npx vercel env add PRIM_KEY production
#    -> valeur à coller :
#       grep '^prim_api_key=' /Users/mattsco/garmin/garmin_RER_A/api_key | cut -d= -f2

# 3) Déploiement en production
npx vercel --prod
```

`vercel --prod` affiche une URL type `https://mattsco-api.vercel.app`.
**Teste la route RER :**

```bash
curl -s "https://mattsco-api.vercel.app/api/rer"
# attendu : {"deps":[{"min":3,"dest":"Marne-Vallee"},{"min":9,"dest":"Marne-Vallee"}, ...]}
```

Donne-moi l'URL : je la fige dans `garmin_RER_A/source/Config.mc` et l'app est finie.

## Ajouter d'autres routes plus tard
Crée simplement `api/<nom>.js` (même format `export default async function handler(req,res)`)
puis `npx vercel --prod`. Toutes les routes partagent les variables d'env du projet.

## Notes
- La route `/api/rer` est publique mais inoffensive (horaires publics). La clé PRIM
  reste côté serveur. Pour la protéger : ajoute `?t=unsecret` et vérifie-le dans `rer.js`.
- Cache 20 s (`s-maxage`) → consultations rapprochées ne tapent pas PRIM à chaque fois.
