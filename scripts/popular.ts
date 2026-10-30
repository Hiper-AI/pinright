/**
 * Regenerates src/data/popular.ts, the names typosquatters imitate.
 * Run: npx tsx scripts/popular.ts
 *
 * Sources, pinned so two runs give the same file:
 *   npm  : the npm-high-impact package by Titus Wormer (wooorm), lists of the most
 *          downloaded and most depended-on packages, regenerated from the npm
 *          registry by its maintainer. The tarball comes from registry.npmjs.org and
 *          is checked against the registry's sha512 integrity before it is read.
 *   PyPI : hugovk/top-pypi-packages (30-day download counts from the PyPI BigQuery
 *          dataset), at a fixed commit of the GitHub repository.
 * The hand-picked seeds below go first, so names that matter to agents (and
 * ecosystems without a public ranking) stay in the list whatever the ranking says.
 * To move to newer data, bump NPM_HIGH_IMPACT and PYPI_COMMIT and run it again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const NPM_HIGH_IMPACT = '1.13.0';
const PYPI_COMMIT = 'e6b5b398c1fcc783f593031f99bc2c772d64c6ef';
const NPM_TOP_DOWNLOADS = 3000;
const NPM_TOP_DEPENDENTS = 1000;
const PYPI_TOP = 3000;

const CURATED: Record<string, string[]> = {
  npm: [
    'react', 'react-dom', 'next', 'vue', 'nuxt', 'svelte', 'angular', '@angular/core',
    'express', 'fastify', 'koa', 'hono', 'nest', '@nestjs/core',
    'lodash', 'underscore', 'ramda', 'moment', 'dayjs', 'date-fns', 'luxon',
    'axios', 'node-fetch', 'undici', 'got', 'superagent', 'request',
    'typescript', 'ts-node', 'tsx', 'esbuild', 'vite', 'webpack', 'rollup', 'parcel', 'babel', '@babel/core',
    'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'chai', 'cypress', 'playwright', 'puppeteer',
    'mongoose', 'mongodb', 'pg', 'mysql2', 'sqlite3', 'better-sqlite3', 'prisma', '@prisma/client',
    'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'redis', 'ioredis',
    'jsonwebtoken', 'jose', 'bcrypt', 'bcryptjs', 'passport', 'helmet', 'cors', 'dotenv',
    'zod', 'yup', 'joi', 'ajv', 'class-validator',
    'commander', 'yargs', 'inquirer', 'chalk', 'ora', 'debug', 'winston', 'pino', 'morgan',
    'socket.io', 'ws', 'uuid', 'nanoid', 'semver', 'glob', 'minimatch', 'fs-extra', 'rimraf', 'mkdirp',
    'cheerio', 'jsdom', 'marked', 'markdown-it', 'highlight.js', 'sharp', 'jimp', 'multer', 'formidable',
    'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'styled-components', '@emotion/react',
    'redux', '@reduxjs/toolkit', 'zustand', 'mobx', 'rxjs', 'immer',
    'graphql', 'apollo-server', '@apollo/client', 'urql',
    'openai', '@anthropic-ai/sdk', 'langchain', '@langchain/core', 'ai', '@modelcontextprotocol/sdk',
    'stripe', 'twilio', 'nodemailer', 'aws-sdk', '@aws-sdk/client-s3', 'firebase', 'firebase-admin',
    'electron', 'react-native', 'expo', 'three', 'd3', 'chart.js', 'leaflet',
    'colors', 'faker', '@faker-js/faker', 'cross-env', 'node-sass', 'nodemon', 'pm2', 'husky',
  ],
  pypi: [
    'requests', 'urllib3', 'httpx', 'aiohttp', 'certifi', 'idna', 'charset-normalizer',
    'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'sklearn', 'statsmodels',
    'torch', 'tensorflow', 'keras', 'transformers', 'datasets', 'tokenizers', 'accelerate',
    'openai', 'anthropic', 'langchain', 'langchain-core', 'llama-index', 'tiktoken', 'mcp',
    'flask', 'django', 'fastapi', 'starlette', 'uvicorn', 'gunicorn', 'tornado', 'bottle',
    'sqlalchemy', 'alembic', 'psycopg2', 'psycopg2-binary', 'psycopg', 'pymysql', 'pymongo', 'redis', 'peewee',
    'pydantic', 'pydantic-settings', 'attrs', 'marshmallow', 'cerberus',
    'pytest', 'pytest-cov', 'tox', 'nox', 'coverage', 'hypothesis', 'mock',
    'black', 'ruff', 'flake8', 'pylint', 'mypy', 'isort', 'pre-commit',
    'click', 'typer', 'rich', 'tqdm', 'colorama', 'tabulate', 'loguru',
    'boto3', 'botocore', 's3transfer', 'google-cloud-storage', 'google-api-python-client', 'azure-storage-blob',
    'beautifulsoup4', 'bs4', 'lxml', 'selenium', 'playwright', 'scrapy', 'html5lib',
    'pillow', 'opencv-python', 'imageio', 'pyyaml', 'toml', 'tomli', 'python-dotenv', 'jinja2', 'markupsafe',
    'cryptography', 'pycryptodome', 'pyjwt', 'passlib', 'bcrypt', 'paramiko', 'pyopenssl',
    'celery', 'kombu', 'rq', 'apscheduler', 'schedule',
    'setuptools', 'wheel', 'pip', 'poetry', 'virtualenv', 'six', 'packaging', 'typing-extensions',
    'python-dateutil', 'pytz', 'arrow', 'pendulum', 'orjson', 'ujson', 'simplejson', 'msgpack',
    'websockets', 'websocket-client', 'grpcio', 'protobuf', 'kafka-python', 'pika',
    'jupyter', 'notebook', 'ipython', 'streamlit', 'gradio', 'dash', 'plotly', 'bokeh',
  ],
  cargo: [
    'serde', 'serde_json', 'tokio', 'rand', 'syn', 'quote', 'proc-macro2', 'libc', 'log', 'thiserror', 'anyhow',
    'clap', 'regex', 'reqwest', 'hyper', 'axum', 'actix-web', 'rocket', 'warp', 'tonic', 'prost',
    'futures', 'async-trait', 'bytes', 'chrono', 'time', 'uuid', 'base64', 'hex', 'sha2', 'ring', 'rustls',
    'once_cell', 'lazy_static', 'itertools', 'rayon', 'crossbeam', 'parking_lot', 'tracing', 'env_logger',
    'sqlx', 'diesel', 'rusqlite', 'tempfile', 'walkdir', 'glob', 'url', 'http', 'tower', 'mio',
  ],
  go: [
    'github.com/gin-gonic/gin', 'github.com/gorilla/mux', 'github.com/labstack/echo', 'github.com/gofiber/fiber',
    'github.com/spf13/cobra', 'github.com/spf13/viper', 'github.com/stretchr/testify', 'github.com/sirupsen/logrus',
    'go.uber.org/zap', 'github.com/pkg/errors', 'github.com/google/uuid', 'golang.org/x/crypto', 'golang.org/x/net',
    'gorm.io/gorm', 'github.com/lib/pq', 'github.com/jackc/pgx', 'github.com/go-redis/redis', 'github.com/redis/go-redis',
    'google.golang.org/grpc', 'google.golang.org/protobuf', 'github.com/golang-jwt/jwt', 'github.com/dgrijalva/jwt-go',
  ],
  rubygems: [
    'rails', 'rack', 'sinatra', 'puma', 'unicorn', 'nokogiri', 'devise', 'rspec', 'minitest', 'rubocop',
    'bundler', 'rake', 'json', 'activerecord', 'activesupport', 'sidekiq', 'redis', 'pg', 'mysql2', 'sqlite3',
    'faraday', 'httparty', 'rest-client', 'jwt', 'bcrypt', 'dotenv', 'pry', 'byebug', 'capybara', 'selenium-webdriver',
  ],
};

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { 'user-agent': 'pinright-popular-script' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

/** The files of a .tgz, by path. Plain ustar is all npm tarballs use. */
function untar(tgz: Buffer): Map<string, string> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, string>();
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 500);
    const size = Number.parseInt(field(124, 136).trim() || '0', 8);
    const full = prefix ? `${prefix}/${name}` : name;
    files.set(full, tar.subarray(off + 512, off + 512 + size).toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** `export const x = ['a', 'b', ...]` -> ['a', 'b', ...] */
function namesIn(js: string): string[] {
  return [...js.matchAll(/^\s*'((?:[^'\\]|\\.)+)',?\s*$/gm)].map((m) => m[1]);
}

async function npmLists(): Promise<{ downloads: string[]; dependents: string[] }> {
  const meta = (await (await fetchOk(`https://registry.npmjs.org/npm-high-impact/${NPM_HIGH_IMPACT}`)).json()) as {
    dist: { tarball: string; integrity: string };
  };
  const tgz = Buffer.from(await (await fetchOk(meta.dist.tarball)).arrayBuffer());
  const [algo, expected] = meta.dist.integrity.split('-');
  const actual = createHash(algo).update(tgz).digest('base64');
  if (actual !== expected) throw new Error(`integrity mismatch for npm-high-impact@${NPM_HIGH_IMPACT}`);
  const files = untar(tgz);
  const read = (f: string) => {
    const body = files.get(`package/lib/${f}`);
    if (!body) throw new Error(`npm-high-impact@${NPM_HIGH_IMPACT} has no lib/${f}`);
    return namesIn(body);
  };
  return { downloads: read('top-download.js'), dependents: read('top-dependent.js') };
}

async function pypiList(): Promise<{ names: string[]; updated: string }> {
  const url = `https://raw.githubusercontent.com/hugovk/top-pypi-packages/${PYPI_COMMIT}/top-pypi-packages.min.json`;
  const data = (await (await fetchOk(url)).json()) as { last_update: string; rows: { project: string }[] };
  return { names: data.rows.map((r) => r.project), updated: data.last_update };
}

function merge(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of lists.flat()) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Names packed into lines of at most ~110 characters, to keep the file short. */
function render(names: string[]): string {
  const lines: string[] = [];
  let cur = '   ';
  for (const n of names) {
    const item = ` ${JSON.stringify(n).replace(/^"|"$/g, "'")},`;
    if (cur.length + item.length > 110) {
      lines.push(cur);
      cur = '   ';
    }
    cur += item;
  }
  if (cur.trim()) lines.push(cur);
  return lines.join('\n');
}

const npm = await npmLists();
const pypi = await pypiList();
const out: Record<string, string[]> = {
  npm: merge(CURATED.npm, npm.downloads.slice(0, NPM_TOP_DOWNLOADS), npm.dependents.slice(0, NPM_TOP_DEPENDENTS)),
  pypi: merge(CURATED.pypi, pypi.names.slice(0, PYPI_TOP)),
  cargo: CURATED.cargo,
  go: CURATED.go,
  rubygems: CURATED.rubygems,
};

const body = Object.entries(out)
  .map(([eco, names]) => `  ${eco}: [\n${render(names)}\n  ],`)
  .join('\n');
const file = `/**
 * Popular package names per ecosystem, the targets typosquatters imitate.
 * Static on purpose: no network call to decide what "popular" means.
 *
 * GENERATED by scripts/popular.ts; edit the seeds there, not this file.
 *   npm : hand-picked seeds, then the top ${NPM_TOP_DOWNLOADS} by downloads and top ${NPM_TOP_DEPENDENTS} by dependents
 *         from npm-high-impact@${NPM_HIGH_IMPACT} (registry tarball, sha512 verified).
 *   pypi: hand-picked seeds, then the top ${PYPI_TOP} by 30-day downloads from
 *         hugovk/top-pypi-packages@${PYPI_COMMIT.slice(0, 12)} (data of ${pypi.updated.slice(0, 10)}).
 *   cargo, go, rubygems: hand-picked seeds only.
 * Order matters: most popular first. findLookalike allows two edits only near the head.
 */
import { type Ecosystem } from '../ecosystems.js';

export const POPULAR: Partial<Record<Ecosystem, string[]>> = {
${body}
};
`;
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'popular.ts');
fs.writeFileSync(target, file);
console.log(Object.entries(out).map(([e, n]) => `${e}: ${n.length}`).join(', '), `-> ${target} (${Math.round(file.length / 1024)} KB)`);
