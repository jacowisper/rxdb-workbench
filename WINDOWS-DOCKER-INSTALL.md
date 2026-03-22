# Windows Docker Install

1. Ensure Docker Desktop is installed and running.
2. In File Explorer, double-click `install-and-run.cmd` in the project root.
3. Follow prompts:
   - `RXDB_PREMIUM` is optional (`NONE` clears it).
   - Ports can be changed if defaults are already in use (`BACKEND_PORT`, websocket, frontend, mongo).
   - Provide Mongo auth credentials (`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`).
4. The script writes `.env`, builds/runs containers, opens the frontend URL, prints container status, and waits for Enter before closing.

Default frontend URL: `http://localhost:8080`
Default MongoDB URL: `mongodb://localhost:27017`

Note:
- The app's default Mongo connection string is set for container-to-container networking:
  - `mongodb://<user>:<password>@mongodb:27017/rxdb-workbench?authSource=admin`

## Uninstall

Double-click `uninstall-and-clean.cmd` in the project root.

It will remove:
- Workbench containers
- Workbench volumes
- Workbench images
- Build cache (`docker buildx prune -af`)

You must type `REMOVE` to confirm before cleanup runs.
