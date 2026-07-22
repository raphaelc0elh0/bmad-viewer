# syntax=docker/dockerfile:1
# bmad-viewer — serves a read-only dashboard for a BMAD project mounted at /project.
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies only. Copy manifests first so the layer caches
# across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application source needed at runtime.
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY .claude ./.claude
COPY example-data ./example-data

EXPOSE 4000

# Bind 0.0.0.0 so the published port is reachable from the host; never auto-open a
# browser inside the container. The project to view is bind-mounted at /project.
ENTRYPOINT ["node", "bin/cli.js", "--no-open", "--host", "0.0.0.0", "--port", "4000"]
CMD ["--path", "/project"]
