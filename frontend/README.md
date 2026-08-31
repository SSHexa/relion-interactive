# frontend/

React + MUI + TypeScript SPA that talks to the Flask backend at `./api/*`.

## Build

```bash
npm ci
npm run build
```

Output → `build/`. Copy that dir to `RELION_FRONTEND_DIR` on your deploy target.

`package.json` has `"homepage": "."` — all asset URLs are relative — so one build works behind any URL prefix (`/pun/sys/...`, `/rnode/host/port/`, etc.) without rebuilding.

## Dev server

```bash
npm start
```

Runs at http://localhost:3000. Expects a backend at http://localhost:5000 (proxied via `package.json` "proxy" field).

Start a backend for it:

```bash
cd ../backend
python3 -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python app.py
```

## What it renders

- Pipeline visualization (`@xyflow/react`) — nodes for each RELION job, edges for I/O dependencies
- Job forms per RELION type (MotionCorr, CtfFind, Class2D, Refine3D, …)
- Live status via SocketIO
- Volume viewer for 3D outputs (`three` + `mrcfile`)
- File browser rooted at the user's project directory
