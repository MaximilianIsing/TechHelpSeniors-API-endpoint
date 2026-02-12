# TechHelpSeniors

Form submission server with admin dashboard for TechHelpSeniors.

## Run locally

```bash
npm install
npm start
```

- **Health:** http://localhost:3000/health  
- **Admin:** http://localhost:3000/admin?key=YOUR_ADMIN_KEY  
  (Admin key is in `admin_pass.txt` or set via `ADMIN_KEY` env var)

## Deploy to Render

1. Create a new **Web Service** on [Render](https://render.com)
2. Connect your repo
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Add environment variables (all caps):
   - `API_KEY` — for form submissions (or uses `api_key.txt`)
   - `ADMIN_KEY` — for admin access (or uses `admin_pass.txt`)

**Note:** Form data and uploads are stored on a Render persistent disk (`/storage`), so they survive deploys. A disk requires a paid Render plan. Locally, data is stored in `data/` and `uploads/` under the project root.

## API

See [docs/index.html](./docs/index.html) for full API documentation (also suitable for [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-from-a-docs-folder-on-your-main-branch)).
