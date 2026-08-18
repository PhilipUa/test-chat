FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source change doesn't reinstall them.
COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

# Compose bind-mounts only the source directories, so this node_modules is the one that gets
# used. A dependency change therefore needs a rebuild: `docker compose up --build`.
# Exec form with node as PID 1, so it receives SIGTERM itself and can shut down gracefully. Going
# through `npm start` means npm is PID 1, and it kills its child instead of forwarding the signal.
CMD ["node", "--import", "tsx", "src/index.ts"]
