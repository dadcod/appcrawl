# AppCrawl website

Single static `index.html` — zero build step.

## Deploy to Cloudflare Pages

1. Push repo to GitHub
2. Go to https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git
3. Select `dadcod/appcrawl` repo
4. Build settings:
   - Build command: *(leave empty)*
   - Build output directory: `website`
5. Deploy
6. Add custom domain: `appcrawl.dev` → Cloudflare auto-provisions SSL

## Local preview

```bash
cd website && python3 -m http.server 8000
# open http://localhost:8000
```
