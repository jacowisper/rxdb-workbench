# RXDB Server Workbench

RXDB Server Workbench is a web UI plus backend service for configuring, deploying, and monitoring a single RxDB replication server against MongoDB.

It includes:

- A Vue frontend workbench for setup and collection operations.
- An Express backend API + WebSocket status/runtime log stream.
- A MongoDB service (via Docker Compose) for storage.

## Prerequisites

- Docker Desktop

## Quick Install (Windows)

This repo includes an interactive installer script.

1. Open this folder.
2. Run `install-and-run.cmd`.
3. Follow prompts for ports and MongoDB credentials.
4. The script creates `.env`, starts containers, and opens the frontend in your browser.

Default URLs/ports:

- Frontend: `http://localhost:8080`
- Backend HTTP: `http://localhost:4000`
- Backend WebSocket: `ws://localhost:4001`
- MongoDB: `mongodb://localhost:27017`

## Docker Install (Any other OS)

1. Create a `.env` file in the project root (example below).
2. Start services:

```bash
docker compose up -d --build
```

3. Open the frontend URL (default `http://localhost:8080`).

### Minimal `.env` Example

```env
RXDB_PREMIUM=
BACKEND_TOKEN=85533878a62652c01f764ba4d7e154ddaf6e7
BACKEND_PORT=4000
BACKEND_DEFAULT_WEBSOCKET_PORT=4001
BACKEND_JSON_BODY_LIMIT=10mb

VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN=85533878a62652c01f764ba4d7e154ddaf6e7
VITE_FRONTEND_TO_USE_BACKEND_URL=http://localhost:4000
VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT=4001
VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING=mongodb://rxdbadmin:rxdbpass@mongodb:27017/rxdb-workbench?authSource=admin

BACKEND_DEFAULT_MONGODB_CONNECTION_STRING=mongodb://rxdbadmin:rxdbpass@mongodb:27017/rxdb-workbench?authSource=admin

FRONTEND_PORT=8080
MONGO_PORT=27017
MONGO_INITDB_ROOT_USERNAME=rxdbadmin
MONGO_INITDB_ROOT_PASSWORD=rxdbpass
MONGO_INITDB_DATABASE=rxdb-workbench
```

## Local Development (Without Docker)

1. Install dependencies:

```bash
npm ci
```

2. Ensure `.env` exists with at least:

- `BACKEND_TOKEN`
- `BACKEND_PORT`
- `BACKEND_DEFAULT_WEBSOCKET_PORT`
- `VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN`
- `VITE_FRONTEND_TO_USE_BACKEND_URL`
- `VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT`

3. Run backend and frontend in separate terminals:

```bash
npm run dev:backend
npm run dev:frontend
```

## Login

Default UI credentials are:

- Username: `admin`
- Password: `admin`

Credentials are stored in browser IndexedDB and can be changed from the workbench UI.

## Stop / Uninstall

- Stop stack: `docker compose down`
- Windows full cleanup script: `uninstall-and-clean.cmd`

The cleanup script removes containers, volumes, images, build cache, and the local `.env`.
