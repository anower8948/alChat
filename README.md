# 💬 alChat

A real-time chat web app with an Apple Messages-inspired UI. Built with Node.js, Express and Socket.IO — zero native dependencies, so it deploys to Azure App Service in minutes.

## Features

- **Real-time 1:1 chat** with typing indicators, delivered/read receipts and online presence
- **Voice & video calls** (WebRTC, peer-to-peer)
- **File & photo sharing** (up to 25 MB, images preview inline)
- **Tapback reactions** — right-click (or long-press on mobile) any bubble: ❤️ 👍 👎 😂 ‼️ ❓
- **Admin dashboard** at `/admin` — add users with username + password, reset passwords, delete users, live stats
- **iMessage-style UI** — blue/gray bubbles with tails, frosted glass, springy animations, automatic dark mode
- **Sounds** — send swoosh, receive ding, ringtone (synthesized with WebAudio, no audio files)
- **Mobile responsive** — works great on phones

## Default login

| Username | Password   |
|----------|------------|
| `admin`  | `admin123` |

⚠️ **Change this immediately** after first login (Admin → Reset password on the admin account).

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Azure (fastest path)

### Option A — Azure CLI (about 2 minutes)

```bash
az login
cd alchat
az webapp up --name <your-unique-app-name> --runtime "NODE:20-lts" --sku B1 --location <region>
```

Then set a permanent session secret and enable WebSockets:

```bash
az webapp config appsettings set --name <your-unique-app-name> --resource-group <rg> \
  --settings JWT_SECRET=$(openssl rand -hex 32)
az webapp config set --name <your-unique-app-name> --resource-group <rg> --web-sockets-enabled true
```

Your app is live at `https://<your-unique-app-name>.azurewebsites.net` 🎉

### Option B — GitHub (recommended for future upgrades)

1. Push this folder to a new GitHub repo:
   ```bash
   git init && git add . && git commit -m "alChat v1"
   git remote add origin https://github.com/<you>/alchat.git
   git push -u origin main
   ```
2. In Azure Portal: **Create Web App** → Runtime **Node 20 LTS** (Linux).
3. Open the Web App → **Deployment Center** → source **GitHub** → pick your repo/branch. Azure creates the GitHub Actions workflow for you automatically; every `git push` redeploys.
4. **Configuration → Application settings**: add `JWT_SECRET` = a long random string.
5. **Configuration → General settings**: turn **Web sockets** ON.

## Important notes

- **HTTPS is required for calls** — browsers only allow mic/camera on HTTPS. Azure App Service gives you HTTPS by default, so calls work out of the box there.
- **Calls behind strict NATs**: this build uses free Google STUN servers. If two users are behind very restrictive corporate networks, add a TURN server (e.g. Azure Communication Services or coturn) to `RTC_CONFIG` in `public/js/app.js`.
- **Storage**: users/messages live in `data/db.json` and uploads in `uploads/`. On Azure App Service these persist under `/home/site/wwwroot`. For larger scale, swap `lib/db.js` for Azure Cosmos DB / PostgreSQL and uploads for Azure Blob Storage — the rest of the code won't change.
- **Scaling**: run on a single instance (default). Scaling out to multiple instances needs a Socket.IO Redis adapter.

## Project structure

```
alchat/
├── server.js              # Express + Socket.IO + WebRTC signaling
├── lib/db.js              # JSON-file database (swap for a real DB later)
├── public/
│   ├── index.html         # Login + chat app
│   ├── admin.html         # Admin dashboard
│   ├── css/style.css      # iMessage-inspired styles
│   └── js/
│       ├── app.js         # Chat client + WebRTC calls
│       ├── admin.js       # Admin dashboard logic
│       └── sounds.js      # WebAudio sound effects
├── uploads/               # Shared files (gitignored)
└── data/                  # db.json lives here (gitignored)
```

## License

MIT — do whatever you like with it.
