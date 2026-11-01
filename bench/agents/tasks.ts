/**
 * Coding tasks for the agent benchmark. Each one makes the agent pick and pin
 * dependency versions, the moment where docs (or the lack of them) decide what
 * ends up in the manifest. The prompt is identical across arms.
 */
export interface AgentTask {
  id: string;
  ecosystem: 'npm' | 'pypi';
  prompt: string;
}

const NPM_RULES =
  'Write a package.json with EXACT pinned versions (no ^ or ~) for every dependency, plus the source file(s). ' +
  'Do not run any command. Keep the code short.';
const PY_RULES =
  'Write a requirements.txt with EXACT pinned versions (name==version) for every dependency, plus the source file(s). ' +
  'Do not run any command. Keep the code short.';

export const TASKS: AgentTask[] = [
  { id: 'next-auth-middleware', ecosystem: 'npm', prompt: `Create a minimal Next.js (App Router) app whose middleware protects /dashboard and redirects unauthenticated users to /login, using Auth.js / next-auth with a GitHub provider. ${NPM_RULES}` },
  { id: 'express-jwt-api', ecosystem: 'npm', prompt: `Create an Express REST API with a /login route that issues a JWT (jsonwebtoken) and a protected /me route. Add cors, helmet and cookie-parser. ${NPM_RULES}` },
  { id: 'axios-client', ecosystem: 'npm', prompt: `Create a Node.js HTTP client module that uploads a file with axios and form-data, with retries via axios-retry. ${NPM_RULES}` },
  { id: 'vite-react-spa', ecosystem: 'npm', prompt: `Create a Vite + React SPA with react-router (two routes) and TanStack Query fetching a JSON endpoint. ${NPM_RULES}` },
  { id: 'xml-yaml-parser', ecosystem: 'npm', prompt: `Create a Node.js CLI that reads an XML file with xml2js and a YAML config with js-yaml, and merges them into JSON. ${NPM_RULES}` },
  { id: 'upload-sharp-s3', ecosystem: 'npm', prompt: `Create an Express endpoint that accepts an image upload with multer, resizes it with sharp and stores it in S3 with @aws-sdk/client-s3. ${NPM_RULES}` },
  { id: 'mcp-server-ts', ecosystem: 'npm', prompt: `Create a TypeScript MCP server (stdio) with @modelcontextprotocol/sdk and zod that exposes one tool, "add", returning the sum of two numbers. ${NPM_RULES}` },
  { id: 'nuxt-app', ecosystem: 'npm', prompt: `Create a minimal Nuxt app with one page that fetches /api/hello from a Nuxt server route. ${NPM_RULES}` },
  { id: 'fastapi-jwt', ecosystem: 'pypi', prompt: `Create a FastAPI app with OAuth2 password login that issues JWTs (python-jose or PyJWT), handles form data with python-multipart, served by uvicorn. ${PY_RULES}` },
  { id: 'flask-proxy', ecosystem: 'pypi', prompt: `Create a Flask app that renders a Jinja2 template and proxies a GET request with requests. Include Werkzeug and gunicorn. ${PY_RULES}` },
  { id: 'langchain-rag', ecosystem: 'pypi', prompt: `Create a small RAG script with LangChain (langchain, langchain-community, langchain-openai) that loads a PDF with pypdf, embeds it into a local FAISS index and answers a question. ${PY_RULES}` },
  { id: 'pandas-pipeline', ecosystem: 'pypi', prompt: `Create a Python data pipeline that reads a YAML config with PyYAML, downloads a CSV with urllib3, transforms it with pandas and writes a PNG chart thumbnail with Pillow. ${PY_RULES}` },
];

export const DOCS_HINT =
  'If you have documentation tools available, use them to check the libraries before choosing versions.';
