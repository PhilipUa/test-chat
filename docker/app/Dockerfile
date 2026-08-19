FROM node:22-slim

# Prisma detects the libssl version to pick its query engine; node:22-slim ships without OpenSSL,
# and the fallback guesses 1.1.x — an engine the clients don't bundle.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source change doesn't reinstall them.
COPY package*.json ./
RUN npm install

COPY . .

# Generate the Prisma clients for this platform. Compose bind-mounts ./src over the image's copy,
# so in compose the host-generated clients (which include the Linux engines via binaryTargets)
# win; this keeps the image correct when run standalone.
RUN npx prisma generate --schema prisma/mysql/schema.prisma \
 && npx prisma generate --schema prisma/mongo/schema.prisma

EXPOSE 3000

# Compose bind-mounts only the source directories, so this node_modules is the one that gets
# used. A dependency change therefore needs a rebuild: `docker compose up --build`.
# Exec form with node as PID 1, so it receives SIGTERM itself and can shut down gracefully. Going
# through `npm start` means npm is PID 1, and it kills its child instead of forwarding the signal.
CMD ["node", "--import", "tsx", "src/index.ts"]
