# Student Manager (Express + MongoDB + one HTML file)

Run locally: copy `.env.example` to `.env`, put your MongoDB URI in it, then `npm install` and `npm start`. Open http://localhost:3000.

Files: `server.js` (API + serves the site), `public/index.html` (whole website), `postman/` (test collection).

## Deploy on Render
1. MongoDB Atlas (free): create an M0 cluster -> Database Access: add a user + password -> Network Access: add 0.0.0.0/0 -> Connect -> Drivers -> copy the connection string, put your password in it and add `/studentdb` before the `?`.
2. Push this folder to a GitHub repo (`package.json` must be at the repo root).
3. Render -> New + -> Web Service -> pick the repo. Runtime Node, Build `npm install`, Start `npm start`, Instance Free.
4. Environment -> add `MONGODB_URI` = your Atlas string. Create Web Service.
5. Open your `https://<name>.onrender.com` URL. Health check: `/health`.
