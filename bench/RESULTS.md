# Benchmark: Context7 vs safectx

Run on 2026-10-29 against the live APIs, 71 s.

## Summary

| Metric | Value |
|---|---|
| Libraries in the set | 96 |
| Mapped to a registry package | 96 (100%) |
| With versioned docs in Context7 | 50 |
| Newest Context7-pinned version has >= 1 advisory | 12 of 50 (24%) |
| Any Context7-pinned version has >= 1 advisory | 24 of 50 (48%) |
| Registry latest has >= 1 advisory | 0 of 96 (0%) |
| safectx recommendation has >= 1 advisory | 0 of 96 (0%) |
| safectx could not recommend a version | 0 |
| safectx recommendation differs from registry latest | 19 |

### Dependabot alerts the day after install (sum of advisories over the set)

| Choice of version | Alerts |
|---|---|
| Newest version Context7 has docs for | 118 |
| Registry latest | 0 |
| safectx recommendation | 0 |

## Per library

| Context7 id | Package | Newest C7-pinned (advisories) | Latest (advisories) | safectx (advisories) | Verdict |
|---|---|---|---|---|---|
| /vercel/next.js | npm:next | 16.2.9 (20) | 16.4.3 (0) | 16.4.3 (0) | ok |
| /facebook/react | npm:react | - | 19.3.1 (0) | 19.3.1 (0) | ok |
| /vuejs/core | npm:vue | - | 3.5.44 (0) | 3.5.44 (0) | ok |
| /nuxt/nuxt | npm:nuxt | 4.0.0 (18) | 4.6.3 (0) | 4.6.2 (0) | ok |
| /sveltejs/svelte | npm:svelte | 1.64.1 (8) | 5.57.3 (0) | 5.57.2 (0) | ok |
| /angular/angular | npm:@angular/core | 20.0.0 (8) | 22.2.3 (0) | 22.2.3 (0) | ok |
| /expressjs/express | npm:express | 5.3.0 (0) | 5.3.0 (0) | 5.3.0 (0) | ok |
| /fastify/fastify | npm:fastify | 5.12.7 (0) | 5.12.7 (0) | 5.12.7 (0) | ok |
| /honojs/hono | npm:hono | 4.13.14 (0) | 4.13.14 (0) | 4.13.14 (0) | ok |
| /nestjs/nest | npm:@nestjs/core | - | 12.3.2 (0) | 12.2.0 (0) | ok |
| /koajs/koa | npm:koa | 2.16.3 (1) | 3.2.1 (0) | 3.2.1 (0) | ok |
| /prisma/prisma | npm:prisma | - | 8.0.0-rc.28 (0) | 7.10.1 (0) | ok |
| /drizzle-team/drizzle-orm | npm:drizzle-orm | 0.45.4 (0) | 0.45.4 (0) | 0.45.4 (0) | ok |
| /typeorm/typeorm | npm:typeorm | 1.1.1 (0) | 1.1.2 (0) | 1.1.2 (0) | ok |
| /knex/knex | npm:knex | - | 3.3.0 (0) | 3.3.0 (0) | ok |
| /Automattic/mongoose | npm:mongoose | - | 9.11.4 (0) | 9.11.4 (0) | ok |
| /colinhacks/zod | npm:zod | 4.6.5 (1) | 4.6.7 (0) | 4.6.7 (0) | ok |
| /axios/axios | npm:axios | 1.13.2 (35) | 1.21.0 (0) | 1.20.0 (0) | ok |
| /lodash/lodash | npm:lodash | 4.18.1 (0) | 4.18.1 (0) | 4.18.1 (0) | ok |
| /date-fns/date-fns | npm:date-fns | 4.1.0 (0) | 4.4.0 (0) | 4.4.0 (0) | ok |
| /iamkun/dayjs | npm:dayjs | - | 1.11.23 (0) | 1.11.23 (0) | ok |
| /tailwindlabs/tailwindcss | npm:tailwindcss | - | 4.3.3 (0) | 4.3.3 (0) | ok |
| /vitejs/vite | npm:vite | 8.0.10 (7) | 8.3.5 (0) | 8.3.5 (0) | ok |
| /webpack/webpack | npm:webpack | 4.47.0 (0) | 5.112.2 (0) | 5.112.2 (0) | ok |
| /vitest-dev/vitest | npm:vitest | 5.0.3 (0) | 5.0.5 (0) | 5.0.5 (0) | ok |
| /jestjs/jest | npm:jest | 29.7.0 (0) | 30.5.2 (0) | 30.5.2 (0) | ok |
| /microsoft/playwright | npm:playwright | 1.63.0 (0) | 1.64.1 (0) | 1.64.1 (0) | ok |
| /puppeteer/puppeteer | npm:puppeteer | - | 25.16.0 (0) | 25.16.0 (0) | ok |
| /cheeriojs/cheerio | npm:cheerio | - | 1.2.0 (0) | 1.2.0 (0) | ok |
| /socketio/socket.io | npm:socket.io | - | 4.8.4 (0) | 4.8.4 (0) | ok |
| /auth0/node-jsonwebtoken | npm:jsonwebtoken | - | 9.0.3 (0) | 9.0.3 (0) | ok |
| /panva/jose | npm:jose | 6.2.13 (0) | 6.2.13 (0) | 6.2.13 (0) | ok |
| /expressjs/cors | npm:cors | - | 2.8.6 (0) | 2.8.6 (0) | ok |
| /helmetjs/helmet | npm:helmet | 8.3.0 (0) | 8.3.0 (0) | 8.3.0 (0) | ok |
| /motdotla/dotenv | npm:dotenv | - | 18.0.9 (0) | 18.0.9 (0) | ok |
| /reduxjs/redux-toolkit | npm:@reduxjs/toolkit | 2.11.0 (0) | 2.13.0 (0) | 2.13.0 (0) | ok |
| /pmndrs/zustand | npm:zustand | 5.0.12 (0) | 5.0.16 (0) | 5.0.16 (0) | ok |
| /TanStack/query | npm:@tanstack/react-query | - | 5.105.0 (0) | 5.104.5 (0) | ok |
| /remix-run/react-router | npm:react-router | 7.6.2 (13) | 8.5.1 (0) | 8.5.0 (0) | ok |
| /openai/openai-node | npm:openai | - | 7.45.1 (0) | 7.43.0 (0) | ok |
| /anthropics/anthropic-sdk-typescript | npm:@anthropic-ai/sdk | - | 1.3.0 (0) | 1.3.0 (0) | ok |
| /langchain-ai/langchainjs | npm:langchain | - | 1.6.0 (0) | 1.5.19 (0) | ok |
| /vercel/ai | npm:ai | - | 7.0.156 (0) | 7.0.153 (0) | ok |
| /modelcontextprotocol/typescript-sdk | npm:@modelcontextprotocol/sdk | - | 1.32.2 (0) | 1.32.2 (0) | ok |
| /supabase/supabase-js | npm:@supabase/supabase-js | 2.118.0 (0) | 2.118.0 (0) | 2.118.0 (0) | ok |
| /firebase/firebase-js-sdk | npm:firebase | - | 13.1.0 (0) | 13.1.0 (0) | ok |
| /stripe/stripe-node | npm:stripe-node | - | 6.0.0 (0) | 6.0.0 (0) | ok |
| /aws/aws-sdk-js-v3 | npm:@aws-sdk/client-s3 | 3.1153.0 (0) | 3.1159.0 (0) | 3.1156.0 (0) | ok |
| /electron/electron | npm:electron | 44.9.1 (0) | 45.1.0 (0) | 45.0.0 (0) | ok |
| /mrdoob/three.js | npm:three.js | - | 0.77.1 (0) | 0.77.1 (0) | ok |
| /d3/d3 | npm:d3 | 3.0.0 (0) | 7.9.0 (0) | 7.9.0 (0) | ok |
| /chartjs/Chart.js | npm:chart.js | - | 4.6.1 (0) | 4.6.1 (0) | ok |
| /psf/requests | pypi:requests | 2.32.0 (4) | 2.34.2 (0) | 2.34.2 (0) | ok |
| /encode/httpx | pypi:httpx | 0.28.1 (0) | 1.0.0.dev6 (0) | 0.28.1 (0) | ok |
| /pallets/flask | pypi:flask | 3.0.0 (2) | 3.1.3 (0) | 3.1.3 (0) | ok |
| /django/django | pypi:django | 6.1 (1) | 6.1.2 (0) | 6.1.2 (0) | ok |
| /fastapi/fastapi | pypi:fastapi | - | 0.162.0 (0) | 0.162.0 (0) | ok |
| /encode/starlette | pypi:starlette | - | 1.10.0 (0) | 1.10.0 (0) | ok |
| /sqlalchemy/sqlalchemy | pypi:sqlalchemy | - | 2.1.6 (0) | 2.1.6 (0) | ok |
| /pydantic/pydantic | pypi:pydantic | 2.14.1 (0) | 2.14.1 (0) | 2.14.1 (0) | ok |
| /numpy/numpy | pypi:numpy | 2.3.1 (0) | 2.5.4 (0) | 2.5.4 (0) | ok |
| /pandas-dev/pandas | pypi:pandas | 3.0.6 (0) | 3.1.0 (0) | 3.1.0 (0) | ok |
| /scikit-learn/scikit-learn | pypi:scikit-learn | 1.9.1 (0) | 1.9.1 (0) | 1.9.1 (0) | ok |
| /pytorch/pytorch | pypi:torch | 2.14.1 (0) | 2.15.0 (0) | 2.14.1 (0) | ok |
| /huggingface/transformers | pypi:transformers | 5.19.0 (0) | 5.21.0 (0) | 5.20.2 (0) | ok |
| /openai/openai-python | pypi:openai | 2.11.0 (0) | 3.41.0 (0) | 3.37.0 (0) | ok |
| /anthropics/anthropic-sdk-python | pypi:anthropic | 1.13.0 (0) | 2.3.0 (0) | 2.3.0 (0) | ok |
| /langchain-ai/langchain | pypi:langchain | - | 1.4.7 (0) | 1.4.7 (0) | ok |
| /run-llama/llama_index | pypi:llama_index | - | 0.14.25 (0) | 0.14.25 (0) | ok |
| /boto/boto3 | pypi:boto3 | 1.35.88 (0) | 1.43.121 (0) | 1.43.118 (0) | ok |
| /pytest-dev/pytest | pypi:pytest | 9.1.1 (0) | 9.2.0 (0) | 9.1.1 (0) | ok |
| /pallets/click | pypi:click | 8.4.2 (0) | 8.5.0 (0) | 8.5.0 (0) | ok |
| /tiangolo/typer | pypi:typer | - | 0.27.3 (0) | 0.27.3 (0) | ok |
| /Textualize/rich | pypi:rich | - | 15.0.0 (0) | 15.0.0 (0) | ok |
| /python-pillow/Pillow | pypi:pillow | - | 13.0.0 (0) | 13.0.0 (0) | ok |
| /yaml/pyyaml | pypi:pyyaml | 6.0.3 (0) | 6.0.3 (0) | 6.0.3 (0) | ok |
| /celery/celery | pypi:celery | 5.6.3 (0) | 5.6.3 (0) | 5.6.3 (0) | ok |
| /redis/redis-py | pypi:redis | 7.4.0 (0) | 8.1.0 (0) | 8.1.0 (0) | ok |
| /modelcontextprotocol/python-sdk | pypi:mcp | - | 2.3.0 (0) | 2.3.0 (0) | ok |
| /streamlit/streamlit | pypi:streamlit | 1.65.0 (0) | 1.66.1 (0) | 1.66.1 (0) | ok |
| /gradio-app/gradio | pypi:gradio | - | 6.31.0 (0) | 6.30.0 (0) | ok |
| /tokio-rs/tokio | cargo:tokio | - | 1.54.1 (0) | 1.54.1 (0) | ok |
| /serde-rs/serde | cargo:serde | 1.0.229 (0) | 1.0.229 (0) | 1.0.229 (0) | ok |
| /clap-rs/clap | cargo:clap | 3.2.25 (0) | 4.6.7 (0) | 4.6.7 (0) | ok |
| /seanmonstar/reqwest | cargo:reqwest | 0.13.5 (0) | 0.13.5 (0) | 0.13.5 (0) | ok |
| /tokio-rs/axum | cargo:axum | - | 0.8.9 (0) | 0.8.9 (0) | ok |
| /actix/actix-web | cargo:actix-web | - | 4.18.1 (0) | 4.18.1 (0) | ok |
| /gin-gonic/gin | go:github.com/gin-gonic/gin | - | v1.12.0 (0) | v1.12.0 (0) | ok |
| /spf13/cobra | go:github.com/spf13/cobra | - | v1.10.2 (0) | v1.10.2 (0) | ok |
| /stretchr/testify | go:github.com/stretchr/testify | - | v1.12.1 (0) | v1.12.1 (0) | ok |
| /go-gorm/gorm | go:gorm.io/gorm | - | v1.31.2 (0) | v1.31.2 (0) | ok |
| /labstack/echo | go:github.com/labstack/echo/v5 | - | v5.4.2 (0) | v5.4.2 (0) | ok |
| /rails/rails | rubygems:rails | - | 8.1.4 (0) | 8.1.4 (0) | ok |
| /sinatra/sinatra | rubygems:sinatra | - | 4.2.1 (0) | 4.2.1 (0) | ok |
| /sparklemotion/nokogiri | rubygems:nokogiri | - | 1.19.4 (0) | 1.19.4 (0) | ok |
| /rspec/rspec-core | rubygems:rspec-core | - | 3.13.6 (0) | 3.13.6 (0) | ok |
