FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.165.0
LABEL org.openai.codex.version=${CODEX_VERSION}
RUN npm install --global --no-audit --no-fund --loglevel=verbose \
    --fetch-retries=1 --fetch-timeout=30000 "@openai/codex@${CODEX_VERSION}"
# The official Node image already supplies the unprivileged `node` user (uid 1000).
USER node
CMD ["codex"]
