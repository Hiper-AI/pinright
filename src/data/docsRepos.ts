/**
 * Packages whose real documentation lives somewhere other than their own
 * repository: a separate docs repo, a docs site with a per-language llms.txt
 * index, a wiki. Also the "split" families (LangChain) whose features ship in
 * sibling packages that a project has to install by name.
 *
 * npm packages normally document themselves (published files, repo at the tag);
 * the npm entries are the exceptions whose docs live only in a site repo.
 */
import { type Ecosystem } from '../ecosystems.js';

export interface DocsSource {
  /**
   * A GitHub repo holding the docs; `paths` are path prefixes (or exact files) inside it.
   * `fill` marks the guide pages that may fill the answer without a path match when the
   * docs set is too large for all of it to (Tailwind's 200 pages are mostly one per utility).
   */
  repo?: { owner: string; repo: string; paths: string[]; exclude?: RegExp; fill?: RegExp };
  /** An llms.txt-style index (markdown list of links) whose pages are served as markdown. */
  llmsIndex?: string;
  /** Docs written for several languages with `:::python` / `:::js` blocks: keep this one. */
  language?: 'python';
}

const LANGCHAIN: DocsSource = {
  // docs.langchain.com is built from langchain-ai/docs; the Python index lists every Python page.
  llmsIndex: 'https://docs.langchain.com/_llms/agent-development-lifecycle/build/python.txt',
  repo: { owner: 'langchain-ai', repo: 'docs', paths: ['src/oss/python/integrations/'] },
  language: 'python',
};

const PYPI: { match: RegExp; source: DocsSource }[] = [
  { match: /^(langchain|langgraph|deepagents)(-.+)?$/, source: LANGCHAIN },
  // PyYAML's documentation is a page of the pyyaml.org site, kept in its own repo.
  { match: /^pyyaml$/, source: { repo: { owner: 'yaml', repo: 'pyyaml.org', paths: ['wiki/PyYAMLDocumentation.md'] } } },
  { match: /^streamlit$/, source: { repo: { owner: 'streamlit', repo: 'docs', paths: ['content/develop/', 'content/get-started/'] } } },
  {
    match: /^selenium$/,
    source: {
      repo: {
        owner: 'SeleniumHQ',
        repo: 'seleniumhq.github.io',
        paths: ['website_and_docs/content/documentation/'],
        exclude: /\.(ja|pt-br|zh-cn)\.md$/,
      },
    },
  },
];

const NPM: { match: RegExp; source: DocsSource }[] = [
  // tailwindcss.com is built from this repo: one .mdx per page, no llms.txt; the npm package ships only a README.
  {
    match: /^(tailwindcss|@tailwindcss\/.+)$/,
    source: {
      repo: {
        owner: 'tailwindlabs',
        repo: 'tailwindcss.com',
        paths: ['src/docs/'],
        fill: /\/(theme|adding-custom-styles|functions-and-directives|dark-mode|styling-with-utility-classes|hover-focus-and-other-states|responsive-design|detecting-classes-in-source-files|preflight|compatibility)\.mdx$/,
      },
    },
  },
];

/** PyPI normalizes names: case-insensitive, with "-", "_" and "." equivalent. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function docsSourceFor(eco: Ecosystem, name: string): DocsSource | undefined {
  if (eco === 'npm') return NPM.find((e) => e.match.test(name))?.source;
  if (eco !== 'pypi') return undefined;
  const n = normalizePypiName(name);
  return PYPI.find((e) => e.match.test(n))?.source;
}

// ------------------------------------------------------------ split families ---

export interface SiblingPackage {
  /** PyPI name to install. */
  pkg: string;
  /** Top-level import name it provides. */
  importName: string;
  /** What it provides, for the note shown to the agent. */
  what: string;
  /** Query terms that mean the agent needs it. */
  terms: RegExp;
}

interface Family {
  members: RegExp;
  siblings: SiblingPackage[];
}

const FAMILIES: Family[] = [
  {
    // LangChain 1.x is split: `langchain` holds agents, the rest live in sibling packages.
    members: /^(langchain|langgraph|deepagents)(-.+)?$/,
    siblings: [
      { pkg: 'langchain-core', importName: 'langchain_core', what: 'base abstractions: messages, prompts, documents, runnables, InMemoryVectorStore', terms: /\b(prompt ?templates?|runnables?|InMemoryVectorStore|output ?parsers?|langchain_core)\b/i },
      { pkg: 'langchain-text-splitters', importName: 'langchain_text_splitters', what: 'text splitters such as RecursiveCharacterTextSplitter', terms: /\b(text ?splitters?|split(ting|ter)?|chunk(s|ing)?|RecursiveCharacterTextSplitter|langchain_text_splitters)\b/i },
      { pkg: 'langchain-community', importName: 'langchain_community', what: 'community integrations: document loaders (PyPDFLoader, WebBaseLoader, CSVLoader), vector stores (FAISS), retrievers', terms: /\b(pdf|loaders?|PyPDFLoader|WebBaseLoader|faiss|community|langchain_community)\b/i },
      { pkg: 'langchain-openai', importName: 'langchain_openai', what: 'OpenAI chat models and embeddings (ChatOpenAI, OpenAIEmbeddings)', terms: /\b(openai|gpt-?\w*|ChatOpenAI|OpenAIEmbeddings|langchain_openai)\b/i },
      { pkg: 'langchain-anthropic', importName: 'langchain_anthropic', what: 'Anthropic chat models (ChatAnthropic)', terms: /\b(anthropic|claude|ChatAnthropic)\b/i },
      { pkg: 'langchain-google-genai', importName: 'langchain_google_genai', what: 'Gemini chat models and embeddings', terms: /\b(gemini|google ?genai|ChatGoogleGenerativeAI)\b/i },
      { pkg: 'langchain-ollama', importName: 'langchain_ollama', what: 'Ollama chat models and embeddings', terms: /\bollama\b/i },
      { pkg: 'langchain-huggingface', importName: 'langchain_huggingface', what: 'Hugging Face models and embeddings', terms: /\b(hugging ?face|HuggingFaceEmbeddings)\b/i },
      { pkg: 'langchain-chroma', importName: 'langchain_chroma', what: 'the Chroma vector store', terms: /\bchroma(db)?\b/i },
      { pkg: 'langchain-classic', importName: 'langchain_classic', what: 'legacy chains and retrievers from LangChain 0.x (RetrievalQA, LLMChain)', terms: /\b(legacy|RetrievalQA|LLMChain|langchain_classic)\b/i },
      { pkg: 'langgraph', importName: 'langgraph', what: 'graphs and the agent runtime (StateGraph)', terms: /\b(langgraph|StateGraph)\b/i },
      { pkg: 'pypdf', importName: 'pypdf', what: 'PDF parsing used by PyPDFLoader', terms: /\b(pdf|PyPDFLoader)\b/i },
      { pkg: 'faiss-cpu', importName: 'faiss', what: 'the FAISS index used by the FAISS vector store', terms: /\bfaiss\b/i },
    ],
  },
];

export function siblingsFor(name: string): SiblingPackage[] {
  const n = normalizePypiName(name);
  return FAMILIES.find((f) => f.members.test(n))?.siblings ?? [];
}

/** Import names whose PyPI package has a different name. */
export const IMPORT_TO_PYPI: Record<string, string> = {
  yaml: 'pyyaml',
  PIL: 'pillow',
  bs4: 'beautifulsoup4',
  sklearn: 'scikit-learn',
  cv2: 'opencv-python',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  jwt: 'pyjwt',
  faiss: 'faiss-cpu',
  magic: 'python-magic',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'pymupdf',
  attr: 'attrs',
  serial: 'pyserial',
  OpenSSL: 'pyopenssl',
  Crypto: 'pycryptodome',
  multipart: 'python-multipart',
  jose: 'python-jose',
  slugify: 'python-slugify',
};
