# Disposable Linux sandbox for the shell arm of the agent benchmark (bench/agents/run.ts --sandbox docker).
# Agents in this arm have Bash, so they run real `npm install` / `pip install`, install scripts included.
# Every job runs in a fresh container from this image and the container is removed when the job ends.
#
#   docker build -f bench/agents/sandbox/Dockerfile -t pinright-bench-sandbox:local .
#
# Build context: the repository root (pinright is built from it). See Dockerfile.dockerignore.
FROM node:22-bookworm AS node

FROM python:3.12-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && python -m venv /opt/tools \
 && /opt/tools/bin/pip install --no-cache-dir uv==0.11.17 pip-audit==2.10.1 \
 && ln -s /opt/tools/bin/uv /opt/tools/bin/uvx /opt/tools/bin/pip-audit /usr/local/bin/ \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.308 \
 && npm cache clean --force

# pinright, built from the build context. Dev dependencies stay: the scorer runs here too (tsx).
WORKDIR /opt/pinright
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY bench ./bench
RUN npm run build && chmod +x bench/agents/sandbox/run-job.sh

# The agent runs as an unprivileged user with a home that exists only in the container.
RUN useradd --create-home --shell /bin/bash agent && mkdir -p /work /job && chown agent:agent /work /job
USER agent
ENV HOME=/home/agent PIP_DISABLE_PIP_VERSION_CHECK=1 DISABLE_AUTOUPDATER=1
WORKDIR /work
ENTRYPOINT ["/opt/pinright/bench/agents/sandbox/run-job.sh"]
