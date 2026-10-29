/**
 * Popular package names per ecosystem, the targets typosquatters imitate.
 * Static on purpose: no network call to decide what "popular" means.
 * Regenerate with `scripts/popular.ts` when it drifts.
 */
import { type Ecosystem } from '../ecosystems.js';

export const POPULAR: Partial<Record<Ecosystem, string[]>> = {
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
    'colors', 'faker', '@faker-js/faker', 'crossenv', 'cross-env', 'node-sass', 'nodemon', 'pm2', 'husky',
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
