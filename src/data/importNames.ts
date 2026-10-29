/**
 * What an import statement needs installed. Python import names often differ
 * from the distribution that provides them (`yaml` is PyYAML); Node resolves
 * builtins without any package. Used by the undeclared-import check
 * (hook/imports.ts) to stay quiet about anything that is not a real gap.
 */
import { builtinModules } from 'node:module';
import { IMPORT_TO_PYPI, normalizePypiName, siblingsFor } from './docsRepos.js';

/**
 * Python standard library top-level modules, from sys.stdlib_module_names (3.14),
 * plus the ones removed in 3.12 and 3.13, so older projects are not flagged.
 */
export const PYTHON_STDLIB = new Set(
  (
    '__future__ _thread abc annotationlib antigravity argparse array ast asyncio atexit base64 bdb binascii bisect ' +
    'builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall compression ' +
    'concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm ' +
    'decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch ' +
    'fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac ' +
    'html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma ' +
    'mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath nturl2path numbers ' +
    'opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath ' +
    'pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline ' +
    'reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib ' +
    'socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct ' +
    'subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap this threading time ' +
    'timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing ' +
    'unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc ' +
    'zipapp zipfile zipimport zlib zoneinfo ' +
    // Removed in 3.12 / 3.13, still imported by older code.
    'aifc asynchat asyncore audioop cgi cgitb chunk crypt distutils imghdr imp lib2to3 mailcap msilib nis nntplib ' +
    'ossaudiodev pipes smtpd sndhdr spwd sunau telnetlib uu xdrlib'
  ).split(' '),
);

/** Import name -> the distributions that provide it, first one suggested. Names equal after PEP 503 normalization need no entry. */
const PY_IMPORTS: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(IMPORT_TO_PYPI).map(([k, v]) => [k, [v]])),
  // LangChain's split packages, from the docs map.
  ...Object.fromEntries(siblingsFor('langchain').map((s) => [s.importName, [s.pkg]])),
  yaml: ['pyyaml'],
  PIL: ['pillow', 'pillow-simd'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'],
  faiss: ['faiss-cpu', 'faiss-gpu'],
  Crypto: ['pycryptodome', 'pycrypto'],
  Cryptodome: ['pycryptodomex'],
  magic: ['python-magic', 'python-magic-bin'],
  psycopg2: ['psycopg2-binary', 'psycopg2'],
  psycopg: ['psycopg', 'psycopg-binary'],
  MySQLdb: ['mysqlclient'],
  mysql: ['mysql-connector-python'],
  'google.protobuf': ['protobuf'],
  'google.generativeai': ['google-generativeai'],
  'google.genai': ['google-genai'],
  'google.auth': ['google-auth'],
  'google.oauth2': ['google-auth'],
  'googleapiclient': ['google-api-python-client'],
  grpc: ['grpcio'],
  skimage: ['scikit-image'],
  zmq: ['pyzmq'],
  telegram: ['python-telegram-bot'],
  discord: ['discord-py'],
  kafka: ['kafka-python'],
  Levenshtein: ['levenshtein', 'python-levenshtein'],
  gi: ['pygobject'],
  wx: ['wxpython'],
  OpenGL: ['pyopengl'],
  win32api: ['pywin32'],
  win32con: ['pywin32'],
  win32com: ['pywin32'],
  pythoncom: ['pywin32'],
  pywintypes: ['pywin32'],
  pkg_resources: ['setuptools'],
  _pytest: ['pytest'],
  umap: ['umap-learn'],
  mpl_toolkits: ['matplotlib'],
  ruamel: ['ruamel-yaml'],
  Bio: ['biopython'],
  nacl: ['pynacl'],
  socks: ['pysocks'],
  git: ['gitpython'],
  usb: ['pyusb'],
  ldap: ['python-ldap'],
  dns: ['dnspython'],
  websocket: ['websocket-client'],
  engineio: ['python-engineio'],
  socketio: ['python-socketio'],
  corsheaders: ['django-cors-headers'],
  rest_framework: ['djangorestframework'],
  environ: ['django-environ'],
  debug_toolbar: ['django-debug-toolbar'],
  crispy_forms: ['django-crispy-forms'],
  storages: ['django-storages'],
  flask_sqlalchemy: ['flask-sqlalchemy'],
  pydantic_core: ['pydantic-core', 'pydantic'],
  tz: ['pytz'],
  OpenSSL: ['pyopenssl'],
  jwt: ['pyjwt'],
  jose: ['python-jose'],
  multipart: ['python-multipart'],
  slugify: ['python-slugify'],
  fitz: ['pymupdf'],
  serial: ['pyserial'],
  attr: ['attrs'],
  sklearn: ['scikit-learn'],
  bs4: ['beautifulsoup4'],
  dotenv: ['python-dotenv'],
  dateutil: ['python-dateutil'],
  docx: ['python-docx'],
  pptx: ['python-pptx'],
  tree_sitter: ['tree-sitter'],
  speech_recognition: ['speechrecognition'],
  newspaper: ['newspaper3k'],
  pinecone: ['pinecone', 'pinecone-client'],
};

/** Namespace roots shared by many distributions: only a dotted path tells which one. */
const PY_NAMESPACES = new Set(['google', 'azure', 'zope', 'jaraco', 'backports', 'sphinxcontrib', 'opentelemetry', 'oslo', 'plone', 'ruamel']);

/**
 * The distributions that could provide a Python import ("a.b.c"), most likely first.
 * Empty when it cannot be told (an unknown name inside a namespace package).
 */
export function pythonDistributions(importPath: string): { dists: string[]; curated: boolean; module?: string } {
  const parts = importPath.split('.');
  for (let n = Math.min(parts.length, 3); n >= 1; n--) {
    const key = parts.slice(0, n).join('.');
    const hit = PY_IMPORTS[key];
    if (hit?.length) return { dists: hit, curated: true, module: key };
  }
  if (PY_NAMESPACES.has(parts[0])) {
    // google.cloud.storage -> google-cloud-storage: the convention, but not a promise.
    const guesses = [3, 2].filter((n) => parts.length >= n).map((n) => normalizePypiName(parts.slice(0, n).join('-')));
    return { dists: guesses, curated: false };
  }
  return { dists: [normalizePypiName(parts[0])], curated: false };
}

/** Also accepted as declaring an import: the common prefixes and suffixes ("pyyaml" for yaml, "python-docx" for docx). */
export function pythonAliasesOf(top: string): string[] {
  const n = normalizePypiName(top);
  return [n, `py${n}`, `python-${n}`, `${n}-python`, `${n}py`, `${n}-py`];
}

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]));

export function isNodeBuiltin(name: string): boolean {
  return NODE_BUILTINS.has(name.split('/')[0]);
}

/** "@scope/pkg/sub" -> "@scope/pkg", "pkg/sub" -> "pkg"; undefined for anything that is not a registry package. */
export function npmPackageOf(specifier: string): string | undefined {
  const s = specifier.trim();
  // Relative, absolute, aliases (@/, ~/, #, $lib), URLs and protocol specifiers (node:, npm:, virtual:, astro:...).
  if (!s || /^(\.|\/|~|#|\$|@\/|[a-z][a-z0-9+.-]*:)/i.test(s)) return undefined;
  const parts = s.split('/');
  const name = s.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
  if (!name || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined;
  if (isNodeBuiltin(name)) return undefined;
  return name;
}
