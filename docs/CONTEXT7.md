# Context7 in safectx: what Upstash's terms allow

> **Not legal advice.** An engineer wrote this, reading the terms on 2026-10-29. Get a legal
> review before safectx goes public or commercial, and re-read the terms then: Upstash can change
> them at any time (Addendum §9.1).

## How safectx uses Context7

- `src/context7.ts` calls two REST endpoints: `GET /api/v2/libs/search` (from `search.ts`, when no
  registry matches a library name) and `GET /api/v2/context` (from `docs/index.ts`, when the
  package's own docs score below the relevance threshold).
- **Before this change:** on by default (`SAFECTX_CONTEXT7` defaulted to `fallback`), with or
  without a key. Answers were cached on disk in the shared cache: search results 24 h, docs 7 days.
- **Now:** off unless the user sets their own `CONTEXT7_API_KEY`; `SAFECTX_CONTEXT7=off` still turns
  it off. Answers are cached for 24 h in `<cache>/context7/`, and `safectx cache clear context7`
  deletes them.
- **Attribution:** a docs answer from Context7 starts with "local sources were thin, so these come
  from Context7 (`<id>`)" and lists `https://context7.com<id>` as its source.
- **Name reuse:** the MCP tools keep Context7's names (`resolve-library-id`, `query-docs`) and accept
  Context7 ids (`/vercel/next.js`), so "use context7" prompts reach safectx (comment at the top of
  `src/mcp.ts`). The README benchmark has a "Context7" arm (`bench/agents/`), and `bench/run.ts` maps
  its library list through Context7's search.

## The documents

Context7 has no terms page of its own: `context7.com/terms`, `/legal` and `/tos` serve the library
listing. Its footer reads "Context7 is an Upstash project" and links to
<https://upstash.com/docs/common/help/legal>, which lists:

- **Context7 Addendum**, "Effective Date: August 2025":
  <https://upstash.com/trust/context7addendum.pdf>. "In case of conflict between this Addendum and
  the main Terms of Service or Privacy Policy, this Addendum controls with respect to Context7."
- **Upstash Terms of Service**, "Last Update Date: April, 2025": <https://upstash.com/trust/terms.pdf>
- **Upstash Privacy Policy**, April 2025: <https://upstash.com/trust/privacy.pdf> (does not mention
  Context7)

Also read: the API guide <https://context7.com/docs/api-guide.md>, plans
<https://context7.com/docs/plans-pricing.md>, data privacy
<https://context7.com/docs/security/data-privacy.md>, and the MCP server repo
<https://github.com/upstash/context7> (MIT, "Copyright (c) 2021 Upstash, Inc.").

## What the terms say, by topic

### License scope and commercial use

Addendum §2: "Upstash grants Customer and Authorized Users a limited, non-exclusive,
non-transferable license to access and use Context7 for internal development, educational, and
evaluation purposes during the Term."

Addendum §3: "Use Context7 only for legitimate software development and educational purposes"

ToS C.4: "You agree not to reproduce, duplicate, copy, reverse engineer, sell, resell or exploit any
portion of the Service, use of the Service, or access to the Service without Upstash's express
written permission."

The pricing pages contain no commercial-use clause.

**For safectx:** a developer using Context7 through safectx for their own work fits "internal
development". safectx calling Context7 on its users' behalf as part of a product we distribute or
sell does not clearly fit, and C.4 asks for written permission to "exploit ... access to the
Service".

### Use by a competing tool

Addendum §4, "Customer shall not":

- "Use Outputs to build competing documentation services or train competing AI models"
- "Extract documentation content in bulk for unauthorized redistribution or commercial use"
- "Distribute, sublicense, or transfer MCP server configurations or API keys to unauthorized parties"
- "Access Context7 through automated methods beyond the intended MCP and API interfaces"

**For safectx:** this is the highest risk. safectx is a documentation service for coding agents, and
the fallback serves Context7 Outputs inside safectx answers. Per-query fallback is not bulk
extraction, and calls go through the documented REST API. The "competing documentation services"
clause still reads against us. With a bring-your-own key, the user is the Customer and the user's
use is internal development; whether that cures it is the question for Upstash.

### Caching and storage

API guide, "Cache Responses": "Documentation updates are relatively infrequent, so caching responses
for several hours or days reduces API calls and improves performance."

Addendum §10.1: "Customer must cease use of Context7 upon termination and may be required to delete
cached Outputs if requested"

Addendum §10.2: "Customer's rights to use previously obtained Outputs continue subject to applicable
license terms"

**For safectx:** caching is allowed. The old 7-day docs cache was within "days"; it is now 24 h, in a
folder that `safectx cache clear context7` deletes. Entries written before this change sit in the
shared cache and expire within 7 days.

### Attribution

None of the documents requires attribution of Outputs. Addendum §6.3: "The Context7 brand,
interface, and API designs remain Upstash's intellectual property".

**For safectx:** the "these come from Context7" line is good practice and a factual use of the name.
Keep it.

### Name and API design reuse

Addendum §6.3 (above): "API designs remain Upstash's intellectual property".

ToS C.3, users must not "Impersonate any person or entity ... including through false association
with Upstash, or by fraudulently misrepresenting Your identity or site's purpose".

ToS G.1: "You may not duplicate, copy, or reuse any portion of the HTML/CSS, Javascript, or visual
design elements or concepts related to the Website or Services without express written permission
from Upstash."

The MIT license covers the MCP server code only. The README says: "The supporting components — API
backend, parsing engine, and crawling engine — are private and not part of this repository."

**For safectx:** reusing the tool names so that "use context7" prompts land on safectx is the part
Upstash could call a copied API design or a false association. Tool names are not clearly
protected, but the comment in `src/mcp.ts` states that intent in writing.

### Benchmarks

ToS C.8: "You must not perform any benchmark tests or analyses relating to Upstash's Website or
Services without express permission of Upstash."

**For safectx:** `bench/AGENTS.md` and the README table compare a "Context7" arm against safectx.
Publishing them without Upstash's permission conflicts with C.8.

### Rate limits and API keys

API guide: "All API requests require authentication using an API key." The same page, under rate
limits: "**Without API key**: Low rate limits and no custom configuration". On 429 the API sends
`Retry-After` and `RateLimit-*` headers.

Plans: "**1,000 API calls each month** for the MCP server, the CLI, the Search API, and the REST
API". "When a Free account uses all 1,000 calls, requests stop until the next month. Each day until
then, the account gets 20 bonus calls."

Addendum §4: "Circumvent rate limits, access controls, or other protective measures within Context7"

Addendum §3: "Maintain security of account credentials and API keys". ToS A.2: "One person or legal
entity may maintain no more than one free account."

**For safectx:** keyless calls work but the guide says a key is required. Each user should bring
their own key; safectx must never ship one, share one, or rotate keys or IPs around the limit.

### Content ownership

Addendum §6.1: "Documentation Data remains subject to the original licenses and intellectual
property rights of the respective software projects" and "Context7 does not grant additional rights
beyond those already available in the original documentation sources".

**For safectx:** the docs text belongs to each project and keeps its license (CC-BY docs need
attribution to the project, not to Context7). safectx already reads most of that content from the
projects themselves.

### Privacy

Data privacy page: "Context7 stores MCP-formulated queries anonymously and uses them to measure and
improve retrieval accuracy." The client IP is used "for rate limiting".

**For safectx:** the user's question goes to Upstash when the fallback runs. The README now says so
next to `CONTEXT7_API_KEY`.

### Termination and changes

Addendum §10.1: "Upstash may suspend or terminate Context7 access for violations of this Addendum or
the main Terms of Service". §9.1: "Upstash reserves the right to modify, update, or amend this
Addendum at any time at its sole discretion".

**For safectx:** the fallback already fails soft (`.catch(() => undefined)`), so a revoked key costs
docs coverage, not errors.

## Recommendation

**Keep Context7 as an opt-in fallback with the user's own key, and get Upstash's written answer
before going public or commercial.** If Upstash says no, remove it. The safectx benchmark arms
already run with Context7 off, so removing it does not change the published numbers.

Done in this change:

1. Off by default; on only with the user's own `CONTEXT7_API_KEY` (`context7ModeFrom` in
   `src/config.ts`). safectx never calls Context7 keyless.
2. Context7 answers cached for 24 h instead of 7 days, in `<cache>/context7/`, with
   `safectx cache clear context7` to delete them on request.
3. Attribution kept.
4. `src/server.ts` no longer says "configure it like Context7".
5. The README says that with a key, questions go to Upstash under its terms.

Not done, decisions for Juan:

- **The tool names** `resolve-library-id` and `query-docs`, Context7-style ids, and the "use
  context7" intent in `src/mcp.ts`. Renaming breaks existing prompts and configs; keeping them
  carries the §6.3 / C.3 risk.
- **The benchmark.** Remove the Context7 arm from the README and `bench/AGENTS.md` before going
  public, or get permission (ToS C.8). `bench/run.ts` uses Context7 search to map libraries;
  internal evaluation fits §2, publishing the result does not.

## Questions for Upstash (support@upstash.com)

1. May a third-party docs tool for coding agents (safectx) call the Context7 REST API on behalf of
   its users, with each user's own API key? Does Addendum §4 "competing documentation services"
   apply when the user, not safectx, holds the key and the account?
2. Does that change if safectx is commercial or offered as a hosted service?
3. May safectx keep the MCP tool names `resolve-library-id` and `query-docs` and accept Context7
   library ids, so existing prompts keep working? Is there a trademark or naming policy?
4. May we publish a benchmark that includes the Context7 MCP server as one arm (ToS C.8)? On what
   conditions?
5. Is a 24-hour local cache of Outputs on the user's machine acceptable, and how should a deletion
   request (§10.1) reach the end users' caches?
6. Is keyless access supported, or deprecated? The API guide says both.
7. Do you want specific attribution wording or a link when Outputs are shown?
