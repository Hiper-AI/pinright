/**
 * Heuristic scanner for text aimed at an AI agent rather than at a developer:
 * vocatives ("note to AI assistants"), attempts to override instructions, role
 * and tool-call mimicry, secrecy toward the user, credential exfiltration,
 * data-carrying image URLs, encoded payloads and hidden text.
 *
 * Ordinary docs are full of imperatives ("run npm install", "you should call
 * X", "curl ... | sh"), so most rules only count when they come with a sign that
 * the text addresses an agent, and quoted or fenced examples weigh less. The
 * numbers on real docs and on the adversarial set are in bench/injection.
 *
 * Levels: high = drop the passage; medium = keep it with a warning; none.
 */
import { splitFences, type HiddenText } from './normalize.js';

export type Level = 'none' | 'medium' | 'high';

export interface ScanResult {
  level: Level;
  /** Rule ids that fired, strongest first. */
  reasons: string[];
  score: number;
}

type Kind = 'agent' | 'override' | 'secrecy' | 'secret' | 'exfil' | 'shell' | 'tool' | 'steer' | 'role' | 'encoded' | 'hidden';

interface Rule {
  id: string;
  kind: Kind;
  weight: number;
  re: RegExp;
  /** Weight when the match is descriptive ("the model may ignore..."), quoted or inside code. */
  example?: number;
  /** Imperative rules check the word before the match for a descriptive context. */
  imperative?: boolean;
  /** Run on the original text instead of the lowercased skeleton. */
  raw?: boolean;
}

const AGENT_NOUN = String.raw`(?:ai|a\.i\.|llms?|large language models?|language models?|chat ?bots?|(?:ai |coding |code |automated |autonomous )(?:assistants?|agents?)|claude|chatgpt|gpt(?:-?\d[\w.]*)?|copilot|cursor|gemini|codex|windsurf|devin)`;
const NOT_ROLE = String.raw`(?!\s*(?:provider|developer|builder|author|vendor|maintainer|framework|sdk|api|library|platform|company|user|creator|owner|server|client|engineer|researcher|startup|team|product|app|application|tool|class|object|instance|module|package|model\b))`;
const AGENT_LOOSE = String.raw`(?:${AGENT_NOUN}|assistants?|agents?|bots?|models?)${NOT_ROLE}`;
const SECRET_NOUN = String.raw`(?:\.env\b|env(?:ironment)? (?:variables?|vars?|file)|api[_ -]?keys?|secrets?|credentials?|access tokens?|auth tokens?|tokens?|passwords?|private keys?|ssh keys?|aws keys?|session cookies?|cookies|keychain)`;
const SECRET_FILE = String.raw`(?:\.env\b|id_rsa|id_ed25519|id_ecdsa|\.aws\/credentials|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.docker\/config\.json|\.kube\/config|\/etc\/passwd|\/etc\/shadow|hosts\.yml)`;
const DATA_NOUN = String.raw`(?:conversation|chat(?: history)?|context window|context|previous messages?|message history|system prompt|user(?:'s)? (?:data|messages?|input|code|files?)|file contents?|source code|repository contents?|codebase)`;
const URLISH = String.raw`(?:url|query(?: string| param(?:eter)?s?)?|link|image(?: url| link)?|markdown image)`;

/** Names an AI agent as a noun phrase: "LLM-based tools", "AI pair programmers", "automated coding tools", "assistants generating code". */
const AI_WORD = String.raw`(?:ai|a\.i\.|llms?|gpt(?:-?\d[\w.]*)?|claude(?: code)?|chatgpt|copilot|cursor|gemini|codex|windsurf|devin|large language models?|language models?|chat ?bots?|machine readers?|agentic)`;
const AGENT_HEAD = String.raw`(?:assistants?|agents?|tools?|models?|bots?|robots?|(?:pair )?programmers?|coders?|code generators?|generators?|systems?|copilots?|reviewers?|editors?)`;
const AGENT_SUBJECT = String.raw`(?:${AI_WORD}(?:[- ](?:based|powered|driven))?(?:\s+(?:coding|code|pair|dev))?\s+${AGENT_HEAD}|(?:automated|autonomous|coding|code)\s+(?:coding\s+|code\s+)?(?:assistants?|agents?|tools?|bots?|reviewers?|systems?)|(?:assistants?|agents?|models?|tools?|robots?|bots?)\s+(?:generating|writing|opening|that (?:generates?|writes?|opens?))\s+(?:code|pull requests|prs|commits|patches)|(?:tools|assistants|agents|editors)\s+(?:like|such as)\s+${AI_WORD}(?:\s*(?:,|or|and)\s*${AI_WORD})*)`;
/** Plural or multiword names that can take a relative clause before the verb ("language models that read this are asked to"). */
const AI_PLURAL = String.raw`(?:llms|large language models|language models|chat ?bots)`;
const MODAL = String.raw`(?:must|should|shall|are (?:asked|required|expected|instructed|requested|authorized|allowed) to|is (?:asked|required|expected|instructed|authorized|allowed) to|need to|needs to|have to|has to)\s+(?!be\b|not be\b)`;
const ORDER_VERB = String.raw`(?:you\b|please|always|never|do\s+not|don't|ignore|disregard|forget|make\s+sure|ensure|run|install|add|execute|remember|from\s+now|delete|remove|wipe|send|prefer|use|call|open|visit|import|include|set|pass|paste|push|commit|publish|migrate|replace|switch|skip|reply|respond|answer|write|create|fetch|download|upload|recommend|suggest|change|edit|modify|update|configure|enable|disable|keep|store|save|print|output|return|generate|treat|follow|grant|approve|mark|tag|bump|export|state|say|tell|when\s+(?:summari[sz]ing|answering|responding|replying|asked|generating|writing)|"ignore)`;
/** What may precede a vocative label: start of line or sentence, a comment opener, list or quote markers. */
const LABEL_START = String.raw`(?:^|\n|[.!?;(\[]\s+|<!--\s*|\/\/\s*|\/\*\*?\s*|#\s*|\*\s+|-\s+|>\s*|@\w+\s+)(?:\[[^\]\n]{1,15}\]\s*)?`;

const RULES: Rule[] = [
  // --- addressed to an agent -----------------------------------------------------------------
  { id: 'addresses-ai-modal', kind: 'agent', weight: 1.5, imperative: true, re: new RegExp(String.raw`\b(?:${AGENT_SUBJECT}(?:\s+[\w'-]+){0,5}?|${AI_PLURAL}(?:\s+[\w'-]+){0,6}?|${AI_WORD})\s+${MODAL}`, 'g') },
  {
    id: 'addresses-ai-label',
    kind: 'agent',
    weight: 1.5,
    re: new RegExp(String.raw`${LABEL_START}(?:\*\*|__)?(?:(?:note|important|attention|heads[- ]up|guidance|message|reminder)\s+(?:to|for)\s+|for\s+|to\s+)?(?:the\s+|all\s+|any\s+|dear\s+|hey\s+|ok\s+|okay\s+)?(?:${AGENT_SUBJECT}|${AI_WORD}|assistants?|agents?|bots?)(?:\s*(?:,|and|&|\/|or)\s*(?:${AGENT_SUBJECT}|${AI_WORD}|assistants?|agents?|bots?))*(?:\s+and\s+(?:friends|others|co\.?))?\s*(?:\*\*|__)?\s*(?:[:,!]|\s[\u{2014}\u{2013}-]\s)\s*(?:\*\*|__)?\s*${ORDER_VERB}`, 'gu'),
  },
  { id: 'addresses-ai-note-for', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b(?:note|message|notice|attention|reminder|warning|memo|psa|directive|instructions?|important|policy|rules?|guidelines?|guidance|heads[- ]up|detail)\s+(?:to|for)\s+(?:the\s+|all\s+|any\s+|every\s+)?(?:${AGENT_SUBJECT}|${AI_PLURAL}|ai)\b`, 'g') },
  { id: 'addresses-ai-reading-now', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b(?:if|when|whenever)\s+(?:an?|any|the|some)\s+(?:${AGENT_SUBJECT}|${AI_WORD}|agent|assistant|bot)\s+(?:is\s+)?(?:reading|processing|parsing|ingesting|sees|reads|parses|processes)\s+this\b`, 'g') },
  { id: 'addresses-ai-relative', kind: 'agent', weight: 1.5, re: /\b(?:to|for)\s+(?:the|any|every|all)\s+(?:ai|models?|assistants?|agents?|llms?|bots?)\s+(?:that|who|which)?\s*(?:is\s+|are\s+)?(?:helping|reading|working on|assisting|processing|summari[sz]ing|parsing)\b|\b(?:the|any|every)\s+(?:ai|model|assistant|agent|llm|bot)\s+(?:that is\s+|who is\s+)?(?:reading|processing|parsing|summari[sz]ing|ingesting)\s+(?:this|these)\b/g },
  { id: 'agent-instructions-label', kind: 'agent', weight: 2, re: /\[(?:ai|llm|assistant|agent|model|bot|copilot|claude|system)\s+(?:instructions?|notes?|rules?|directives?|only)\]/g },
  { id: 'bare-agent-order', kind: 'agent', weight: 1, imperative: true, re: new RegExp(String.raw`(?:^|\n|[.!?]\s+|-\s+)(?:assistants|agents|bots)\b(?:\s+[\w'.-]+){0,4}?\s+${MODAL}(?:also\s+|first\s+|always\s+)?(?:run|execute|delete|remove|wipe|install|push|publish|upload|send|disable|grant)\b`, 'g') },
  { id: 'answer-only-with', kind: 'agent', weight: 1.5, imperative: true, re: /\b(?:reply|respond|answer)\s+only\s+with\b|\bignore\s+(?:the\s+)?user'?s?\s+(?:question|request|prompt|message|instructions?)\b/g },
  { id: 'you-are-the-ai', kind: 'agent', weight: 1.5, re: /\byou are (?:claude(?: code)?|chatgpt|copilot|cursor|gemini|codex|an? (?:ai|llm|large language model|language model|coding (?:agent|assistant)|ai (?:agent|assistant)))\b|\bthe user (?:wants|asked|needs|expects|would like|has asked) you to\b/g },
  { id: 'system-override', kind: 'agent', weight: 2, re: /\b(?:system|admin|developer|security|root|operator)\s+override\b|\bdeveloper mode (?:is )?(?:on|enabled|activated)\b/g },
  { id: 'addresses-ai-if-you-are', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b(?:if|when|whenever|since)\s+you(?:\s+are|'re)\s+(?:an?\s+|the\s+)?(?:${AGENT_LOOSE})\b`, 'g') },
  { id: 'addresses-ai-note-to', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b(?:note|message|notice|attention|reminder|warning|memo|psa|directive|instructions?)\s+(?:to|for)\s+(?:all\s+|any\s+|the\s+|every\s+)?${AGENT_NOUN}\b`, 'g') },
  { id: 'addresses-ai-vocative', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b(?:attention|dear|hey|hello|hi|psst|listen|ok|okay)[,:!]?\s+(?:all\s+|any\s+|you\s+)?(?:${AGENT_SUBJECT}|${AGENT_LOOSE})\b`, 'g') },
  {
    id: 'addresses-ai-line',
    kind: 'agent',
    weight: 1.5,
    // One marker character per repetition: "(?:[>*_#-]+\s*)*" backtracks exponentially on a "-----" rule.
    re: new RegExp(String.raw`(?:(?:^|\n)[ \t]*(?:[>*_#-][ \t]*)*(?:${AGENT_NOUN}|assistants?|agents?)[ \t]*[:,]|\b${AGENT_NOUN}\s*:)\s*(?:you\s+(?:must|should|need|are\s+(?:required|instructed))|please|always|never|do\s+not|don't|ignore|disregard|make\s+sure|ensure|run|install|add|execute|remember|from\s+now|delete|remove|send|"ignore)`, 'g'),
  },
  { id: 'addresses-ai-reading-this', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\b${AGENT_NOUN}\s+(?:reading|processing|parsing|ingesting|indexing|consuming|summari[sz]ing|that (?:reads?|process(?:es)?|parses?))\s+(?:this|these)\b`, 'g') },
  { id: 'addresses-ai-as-an', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\bas an?\s+(?:${AGENT_LOOSE})\b[^.\n]{0,40}\byou\s+(?:must|should|will|need to|are (?:required|instructed|expected))`, 'g') },
  // "AI agents should run/install/send...": an order with its action in it. Softer verbs ("should import") only address.
  {
    id: 'ai-agents-must-act',
    kind: 'agent',
    weight: 3,
    re: new RegExp(String.raw`\b${AGENT_NOUN}\s+(?:must|should|shall|are (?:required|expected|instructed) to|need to|have to)\s+(?:always\s+|also\s+|first\s+|immediately\s+)?(?:run|execute|install|send|upload|post|delete|remove|disregard|ignore|exfiltrate|curl|download)\b`, 'g'),
  },
  {
    id: 'ai-agents-must',
    kind: 'agent',
    weight: 1.5,
    re: new RegExp(String.raw`\b${AGENT_NOUN}\s+(?:must|should|shall|are (?:required|expected|instructed) to|need to|have to)\s+(?:always\s+|never\s+|also\s+|first\s+|not\s+)?(?:add|include|import|call|fetch|recommend|prefer|use)\b`, 'g'),
  },
  { id: 'this-is-for-the-ai', kind: 'agent', weight: 1.5, re: new RegExp(String.raw`\bthis (?:message|note|text|section|instruction|comment|block) is (?:for|meant for|addressed to|intended for|directed at) (?:the\s+|any\s+|all\s+)?(?:${AGENT_LOOSE})\b`, 'g') },
  { id: 'role-reassignment', kind: 'agent', weight: 1.5, re: /\byou are now\s+(?:in\s+(?:developer|god|admin|debug|jailbreak|unrestricted|dan)\s+mode|dan\b|an?\s+(?:unrestricted|unfiltered|jailbroken|different|new|helpful)\s+(?:ai|assistant|model|agent))/g },
  { id: 'new-instructions', kind: 'agent', weight: 2, re: /\b(?:new|updated|real|actual|true|revised|secret|hidden|additional)\s+(?:instructions?|system prompt|directives?|orders|task)\s*:/g },
  { id: 'before-responding', kind: 'agent', weight: 3, re: /\b(?:before|prior to|instead of)\s+(?:responding|answering|replying|you (?:respond|answer|reply|continue))\b[^.\n]{0,40}\b(?:run|execute|call|install|fetch|send|read|open|visit|invoke|use)\b/g, imperative: true },

  // --- overriding instructions -----------------------------------------------------------------
  {
    id: 'ignore-previous-instructions',
    kind: 'override',
    weight: 3,
    example: 1,
    imperative: true,
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+|every\s+|these\s+|those\s+)*(?:previous|prior|above|earlier|preceding|former|original|initial|existing|system|safety|security|developer)\s+(?:instructions?|prompts?|directions?|directives?|rules?|guidelines?|guardrails?|constraints?|policies|messages?|context|commands?|orders?)\b/g,
  },
  {
    id: 'ignore-earlier-guidance',
    kind: 'override',
    weight: 3,
    example: 1,
    imperative: true,
    re: /\b(?:ignore|disregard|forget|pretend|set aside|discard)\b[^.\n]{0,40}?\b(?:previous|prior|earlier|above|preceding|original|initial|operator'?s?|system|developer)\b[^.\n]{0,25}?\b(?:instructions?|guidance|directions?|directives?|rules|prompts?)\b/g,
  },
  {
    id: 'supersedes-instructions',
    kind: 'override',
    weight: 3,
    example: 1,
    imperative: true,
    re: /\bsupersedes?\s+(?:anything|everything|all|any)\b[^.\n]{0,40}\b(?:system prompt|instructions|you were told|guidelines|rules)\b|\beven if (?:it|this|that) conflicts? with\s+(?:what you were told|your (?:instructions|system prompt|guidelines|rules|operator))|\byour (?:operator|developer|owner|creator|admin|user) has (?:updated|changed|replaced|overridden) your (?:instructions|rules|prompt|guidelines)\b|\btreat (?:the )?(?:instructions|text|content|directions) (?:in|of) this (?:file|page|document|readme|package) as (?:coming from|written by|authored by|issued by|from)\b/g,
  },
  { id: 'real-task', kind: 'agent', weight: 2, re: /\bthe (?:real|actual|true) (?:task|goal|objective|job) is\b|\bchange of plans?\b[^.\n]{0,20}[.:]/g },
  { id: 'instructions-void', kind: 'override', weight: 3, re: /\b(?:your|all|any|the)\s+(?:prior|previous|earlier|original|other|existing)\s+(?:instructions?|directives?|guidance|rules|prompts?|orders)\s+(?:are|is|have been|has been)\s+(?:now\s+)?(?:void|cancell?ed|revoked|obsolete|superseded|replaced|overridden|null|invalid|no longer)\b|\bfrom (?:here|now) on,?\s+(?:follow|obey|do)\s+only\b/g },
  {
    id: 'ignore-instructions-translated',
    kind: 'override',
    weight: 3,
    example: 1,
    raw: true,
    re: /\bignora(?:r)?\s+(?:todas\s+)?(?:las\s+)?instrucciones\s+(?:anteriores|previas)|\bignor[ae]\s+(?:todas\s+)?as\s+instru[çc][õo]es\s+anteriores|\bignore[rz]?\s+(?:toutes\s+)?les\s+instructions\s+(?:pr[ée]c[ée]dentes|ant[ée]rieures)|\bignorier(?:e|en)?\s+(?:sie\s+)?(?:alle\s+)?(?:vorherigen|bisherigen|obigen)\s+anweisungen|\bignora\s+(?:tutte\s+)?le\s+istruzioni\s+precedenti|忽略(?:之前|以上|先前|前面)(?:的)?(?:所有)?(?:指令|指示|说明)|(?:以前|前|上記)の(?:すべての)?指示を無視|игнорируй(?:те)?\s+(?:все\s+)?(?:предыдущие|прежние)\s+инструкции/gi,
  },
  { id: 'ignore-your-rules', kind: 'override', weight: 3, example: 1, imperative: true, re: /\b(?:ignore|disregard|forget)\s+(?:all\s+(?:of\s+)?)?your\s+(?:instructions?|rules?|guidelines?|guardrails?|constraints?|directives?|programming|training|system prompt)\b/g },
  { id: 'ignore-everything-above', kind: 'override', weight: 3, example: 1, imperative: true, re: /\b(?:ignore|disregard|forget)\s+(?:everything|all(?: of)?(?: the)?(?: text| content)?)\s+(?:above|before|you (?:were|have been) told|so far)\b/g },
  { id: 'fence-escape', kind: 'override', weight: 3, example: 3, re: /<\/?untrusted-data\b|\bend of (?:untrusted|third[- ]party) (?:data|content)\b/g },
  { id: 'end-of-context', kind: 'override', weight: 1.5, re: /\b(?:end|stop) of (?:the )?(?:documentation|docs|readme|context|release notes|changelog|user (?:input|data|content)|tool (?:output|result))\s*[.:\]-]*\s*(?:\n|$)/g },

  // --- secrecy toward the user -----------------------------------------------------------------
  {
    id: 'hide-from-user',
    kind: 'secrecy',
    weight: 3,
    re: /\b(?:(?:do not|don't|never)\s+(?:tell|inform|mention(?: this)? to|alert|notify|show)\s+(?:the\s+)?(?:user|human|developer|operator)\s+(?:about\s+)?(?:this|these|that you|what you)|(?:do not|don't|never)\s+(?:mention|reveal|disclose|report|say)\s+(?:this|it|anything)\s+to\s+(?:the\s+)?(?:user|human|developer)|(?:do not|don't|never)\s+(?:mention|reveal|disclose|show|repeat)\s+(?:this|these)\s+(?:instructions?|steps?|messages?|notes?|comments?|text)|keep (?:this|it|these)\s+(?:a\s+)?(?:secret|hidden|between us|confidential)|hide (?:this|it|these)\s+from the (?:user|human|developer))\b/g,
  },
  {
    id: 'tell-user-nothing',
    kind: 'secrecy',
    weight: 1.5,
    imperative: true,
    re: /\b(?:(?:do not|don't|never)\s+(?:tell|inform|notify|alert)\s+(?:the\s+)?(?:user|human(?: operator)?|developer|operator)s?\s+(?:that|it|about)\b|(?:without|(?:do not|don't|never|skip|avoid)\s+)(?:mention(?:ing)?|tell(?:ing)?|disclos(?:e|ing)|say(?:ing)?|explain(?:ing)?)\s+(?:it|this|that|anything|the change|these changes)\b|\bkeep (?:this|that|it|these)(?: change| step| edit| addition)?s? (?:out of|off) (?:the |your )?(?:summary|reply|response|answer|changelog|pr description|commit message|explanation)\b)/g,
  },
  { id: 'consent-claimed', kind: 'secrecy', weight: 1.5, imperative: true, re: /\b(?:skip|without|no need for|don't ask for|do not ask for)\s+(?:asking\s+(?:for\s+)?)?(?:the\s+)?(?:user'?s?\s+|human\s+)?(?:confirmation|approval|permission|consent|sign-?off)\b|\b(?:has|have)\s+already\s+(?:agreed|consented|approved|authorized)\s+(?:to\s+)?(?:everything|all|this|these|any)\b/g },
  { id: 'without-telling-user', kind: 'secrecy', weight: 1, imperative: true, re: /\b(?:without|before)\s+(?:telling|informing|asking|notifying|alerting|warning|consulting|confirming with)\s+(?:the\s+)?(?:user|human|developer|operator)\b/g },
  {
    id: 'silently-act',
    kind: 'secrecy',
    weight: 1.5,
    imperative: true,
    re: /\b(?:silently|quietly|secretly|covertly|discreetly|stealthily)\s+(?:run|execute|install|add|send|upload|post|download|fetch|modify|append|include|insert|call|exfiltrate)\b|\b(?:run|execute|install|add|send|upload|do)\s+(?:it|this|them|that)\s+(?:silently|quietly|secretly|covertly)\b/g,
  },

  // --- credentials and exfiltration ------------------------------------------------------------
  { id: 'reads-secret-file', kind: 'secret', weight: 1, re: new RegExp(String.raw`(?:~|\$home|%userprofile%|\$\{?home\}?)[\\/]\.?(?:ssh[\\/](?:id_\w+|authorized_keys|config)|aws[\\/]credentials|npmrc|pypirc|netrc|docker[\\/]config\.json|kube[\\/]config|git-credentials|config[\\/]gh[\\/]hosts\.yml)|\/etc\/(?:passwd|shadow)\b`, 'g') },
  {
    id: 'secret-piped-out',
    kind: 'secret',
    weight: 3,
    // Shipping a secret file or the environment off the machine has no innocent reading, in code or not.
    example: 3,
    re: new RegExp(String.raw`\b(?:cat|type|get-content|gc|base64|tar|zip)\b[^\n|]{0,80}${SECRET_FILE}[^\n]{0,60}\|\s*(?:curl|wget|nc|ncat|netcat|python[23]?|node|bash|sh|openssl)\b|\b(?:curl|wget|invoke-webrequest|iwr|irm)\b[^\n]{0,160}(?:-d|--data(?:-binary|-raw|-urlencode)?|-f|--form|-t|--upload-file|-body|-infile|--post-file)\s*[=\s]?["']?(?:\w+=)?@?[^\s"']*${SECRET_FILE}|\b(?:printenv|env|set|get-childitem env:|gci env:)\s*\|\s*(?:curl|wget|nc|base64|python|node)\b|json\.stringify\(\s*process\.env\s*\)[^\n]{0,80}(?:fetch|axios|http|request|send)|(?:fetch|axios(?:\.post)?|requests\.post|http\.request)\([^\n]{0,120}(?:process\.env\b(?!\.)|os\.environ\b(?!\.|\[|\.get))`, 'g'),
  },
  { id: 'command-output-in-url', kind: 'exfil', weight: 3, example: 3, re: /(?:\bcurl\b|\bwget\b|https?:\/\/)[^\n]{0,200}\$\((?:cat|env|printenv|whoami|hostname|id|ls|git config|base64)\b/g },
  { id: 'pass-secret', kind: 'secret', weight: 1, imperative: true, re: new RegExp(String.raw`\b(?:pass|send|include|paste|post|upload|forward|share|attach|embed|put|copy)\s+(?:the\s+user'?s\s+|your\s+|their\s+|the\s+|its\s+|all\s+)*(?:[a-z0-9]+_)+(?:api_key|key|token|secret|password)\b|\b(?:paste|post|upload|share|attach)\s+(?:the\s+|your\s+|their\s+)*${SECRET_NOUN}`, 'g') },
  { id: 'send-secrets', kind: 'secret', weight: 2, imperative: true, re: new RegExp(String.raw`\b(?:send|upload|post|paste|transmit|forward|exfiltrate|leak|share|email|submit|report)\s+(?:the\s+|your\s+|all\s+|any\s+|its\s+|their\s+|the user's\s+)*(?:contents? of\s+(?:the\s+)?)?${SECRET_NOUN}[^\n]{0,80}?\b(?:to|at)\s+(?:https?:|www\.|\S+\.\S+\/|(?:this|that|our|my|the following|an? external)\s+(?:url|endpoint|server|webhook|address)|the (?:url|webhook|address) )`, 'g') },
  { id: 'data-into-url', kind: 'exfil', weight: 3, imperative: true, re: new RegExp(String.raw`\b(?:append|add|include|insert|encode|put|embed|attach|pass)\s+(?:the\s+|your\s+|all\s+|this\s+|a summary of\s+(?:the\s+)?)*${DATA_NOUN}\b[^\n.]{0,60}\b(?:to|in|into|as)\s+(?:the\s+|a\s+|this\s+|each\s+)?${URLISH}\b`, 'g') },
  { id: 'secret-into-url', kind: 'exfil', weight: 1, imperative: true, re: new RegExp(String.raw`\b(?:append|add|include|insert|encode|put|embed|attach)\s+(?:the\s+|your\s+|all\s+|this\s+)*${SECRET_NOUN}\b[^\n.]{0,60}\b(?:to|in|into|as)\s+(?:the\s+|a\s+|this\s+)?(?:image(?: url)?|markdown image|link)\b`, 'g') },
  {
    id: 'exfil-image',
    kind: 'exfil',
    weight: 3,
    example: 1,
    raw: true,
    // One bounded, lazy run per URL: two unbounded runs around a separator are cubic on a hostile line.
    re: /!\[[^\]\n]{0,200}\]\(\s*<?https?:\/\/[^)\s]{0,400}?(?:\{\{?|\$\{|\$\(|%7[bB]|<[A-Za-z_]+>|\[(?:[A-Z_]{3,}|data|secret|conversation|context|history|key|token|info|input)\]|\b(?:INSERT|REPLACE|YOUR)_[A-Z_]+)|<img\b[^>]{0,200}\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]{0,400}?(?:\{\{?|\$\{|\$\(|%7[bB]|<[A-Za-z_]+>|\[[A-Z_]{3,}\])/g,
  },
  { id: 'render-this-image', kind: 'exfil', weight: 1, imperative: true, re: /\b(?:render|display|show|output|print|include|embed)\s+(?:this|the following)\s+(?:image|markdown(?: image)?|link|url)\b[^\n.]{0,40}\b(?:in|at the end of|with)\s+(?:your|every|each|the)\s+(?:response|reply|answer|message|output)/g },

  // --- shell, tools, packages ------------------------------------------------------------------
  { id: 'pipe-to-shell', kind: 'shell', weight: 0.5, re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+(?:-\w+\s+)*)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:python[23]?|node|perl|ruby|php)\b|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,200}\|\s*iex\b|\biex\s*\(\s*(?:new-object|iwr|irm|\(new-object)/g },
  { id: 'obfuscated-exec', kind: 'shell', weight: 1.5, example: 1.5, re: /\bbase64[- ]?decode\b[^.\n]{0,30}\b(?:and\s+|then\s+)?(?:run|execute|eval)\b|\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,60}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|buffer\.from|base64)|\bexec\s*\(\s*(?:base64\.b64decode|__import__\(\s*['"]base64)|\bpowershell(?:\.exe)?\s+[^\n]{0,30}-(?:e|enc|encodedcommand)\s+[a-z0-9+/=]{40,}/g },
  { id: 'use-shell-tool', kind: 'tool', weight: 1, imperative: true, re: /\b(?:run|execute|call|invoke|use)\s+(?:the\s+|your\s+)?(?:bash|shell|terminal|run_command|execute_command|computer|code[_ ]execution|edit_file|write_file|str_replace_editor|run_terminal_cmd|web_fetch|fetch)\s+tool\b/g },
  { id: 'immediately-act', kind: 'tool', weight: 1, imperative: true, re: /\b(?:immediately|right away|without (?:delay|hesitation|confirmation|asking))\s*,?\s*(?:run|execute|install|call|invoke|fetch|send|download|delete|curl|wget)\b/g },
  { id: 'steer-install', kind: 'steer', weight: 0.5, imperative: true, re: /\b(?:always|also|additionally|must|make sure (?:to|you)|be sure to|you (?:must|should) (?:also|always))\s+(?:install|add|include|import|require|depend on|recommend|npm install|pip install)\b/g },
  // Zero-weight actions: everyday in docs, they only matter next to text that addresses an agent.
  { id: 'install-command', kind: 'steer', weight: 0, re: /\b(?:npm (?:i|install|add)|npx|yarn (?:add|dlx)|pnpm (?:add|i|install|dlx)|bun (?:add|install|x)|pip3? install|uv (?:add|pip install)|poetry add|gem install|cargo (?:add|install)|go (?:get|install)|composer require|dotnet add)\s+\S/g },
  { id: 'run-command', kind: 'tool', weight: 0, re: /\b(?:run|execute|type|paste|exec|call|invoke|open|visit)\s+(?:this\b|the following|the (?:script|command|url|link)\b|`|\.\/|sudo\b|https?:\/\/)/g },
  {
    id: 'destructive-action',
    kind: 'tool',
    weight: 0.5,
    imperative: true,
    re: /\b(?:delete|remove|wipe|erase|rm -rf|drop|truncate|force-push|push --force)\s+(?:the\s+|all\s+|every\s+|your\s+)?[`'"]?(?:tests?|test folder|files?|folders?|director(?:y|ies)|repo(?:sitory)?|database|tables?|branch(?:es)?|commits?|history|node_modules|lock ?files?|\.github|workflows?|engines|\.\/|~\/|\/)/g,
  },
  { id: 'publish-or-push', kind: 'tool', weight: 0.5, imperative: true, re: /\b(?:npm|yarn|pnpm) publish\b|\btag the release\b|\bcut a release\b|\bapprove (?:this|the) (?:change|pr|pull request)\b|\bmake (?:publish|release|deploy)\b|\btwine upload\b|\bpush (?:it |them |the changes? )?(?:directly )?to (?:main|master|production|prod)\b|\bcommit and push\b|\bwithout (?:review|code review|a review|approval)\b/g },
  { id: 'host-identity-out', kind: 'exfil', weight: 1, re: /\b(?:hostname|host name|username|user name|machine name|ip address|mac address|environment variables?|env vars?|git (?:config|user|email))\b[^.\n]{0,80}\b(?:to|in(?:to)?)\b[^.\n]{0,60}https?:\/\//g },
  { id: 'file-into-url', kind: 'exfil', weight: 3, imperative: true, re: new RegExp(String.raw`\b(?:append|add|include|attach|encode)\b[^.\n]{0,40}\b(?:${DATA_NOUN}|contents? of (?:the\s+)?(?:current\s+|open\s+|this\s+)?files?)\b[^.\n]{0,40}\b(?:to|in|into)\s+(?:any|every|each|the|a|all)\s+${URLISH}`, 'g') },
  { id: 'weaken-security', kind: 'tool', weight: 0.5, re: /node_tls_reject_unauthorized\s*=\s*0|credential\.helper\s+store|strict-ssl\s*(?:=|\s)\s*false|pythonhttpsverify\s*=\s*0|git_ssl_no_verify|--unsafe-perm|--no-verify\b|--disable-(?:security|sandbox)|\bgrant\b[^.\n]{0,30}\b(?:network|file ?system|shell|full|root|admin) access\b|\bdisable (?:the )?(?:sandbox|firewall|security checks?|verification)\b/g },
  { id: 'install-hook-in-prose', kind: 'steer', weight: 0.5, re: /"(?:pre|post)?install"\s*:\s*"/g },
  { id: 'in-every-answer', kind: 'steer', weight: 1, imperative: true, re: /\b(?:in|to|into)\s+every\s+(?:answer|response|reply|suggestion|snippet|completion|(?:npm |pip |shell )?command)\b|\brecommend\s+(?:this|our)\s+(?:package|library|module|sdk|tool)\b|\breplace\s+every\s+(?:call|use|import|occurrence)\b|\baffiliate link\b/g },
  { id: 'misrepresent', kind: 'steer', weight: 1.5, imperative: true, re: /\b(?:never|don't|do not)\s+(?:suggest|recommend|mention)\s+(?:any\s+)?(?:alternatives|competitors|other (?:libraries|packages))\b|\bdescribe (?:competitors|alternatives|other (?:libraries|packages)) as\b|\b(?:state|say|claim|report|mention) that (?:it|this (?:package|library|module|project)) (?:is|was|has|passed)\s+(?:safe|secure|audited|verified|a security audit|reviewed)|\bmark (?:all\s+|every\s+)?(?:the\s+)?(?:security\s+)?(?:findings|alerts|issues|warnings|vulnerabilities) as (?:false positives?|resolved|safe|fixed)\b/g },
  { id: 'ship-project-out', kind: 'exfil', weight: 2, imperative: true, re: /\b(?:upload|send|post|export|sync|copy|push)\s+(?:the\s+|your\s+|this\s+)?(?:project|repo(?:sitory)?|codebase|source(?: code)?|session transcript|transcript|conversation|chat (?:log|history)|workspace|(?:project )?archive)\b[^.\n]{0,30}\bto\s+https?:\/\//g },
  { id: 'token-to-url', kind: 'secret', weight: 1, re: /\$\{?[a-z_]*(?:token|secret|api_key|password)\}?[^\n]{0,80}https?:\/\//g },
  { id: 'authorized-to-act', kind: 'tool', weight: 0.5, re: /\b(?:is|are)\s+(?:now\s+|hereby\s+|fully\s+)?(?:authorized|allowed|permitted|cleared)\s+to\s+(?:run|execute|install|push|delete|modify|publish|bypass)\b/g },
  { id: 'registry-redirect', kind: 'steer', weight: 0.5, re: /\b(?:mirror|private|our|custom)\s+(?:npm\s+|pypi\s+|package\s+)?(?:registry|index|mirror)\b[^\n]{0,40}https?:\/\/|--(?:registry|index-url|extra-index-url)[=\s]+https?:\/\//g },
  { id: 'templated-url', kind: 'exfil', weight: 0.5, re: /https?:\/\/[^\s)"'<>`]{0,300}?[?&][\w-]{1,40}=\{[\w.]{1,40}\}/g },
  { id: 'replace-package', kind: 'steer', weight: 1, imperative: true, re: /\b(?:instead of|rather than|do not use|don't use|never use)\s+[`'"]?[@\w./-]+[`'"]?\s*,?\s*(?:always\s+)?(?:install|use|recommend|import)\s+[`'"]?[@\w./-]+[`'"]?\s+(?:which is|as it is|because it is)?\s*(?:the\s+)?(?:safe|secure|official|patched|maintained|trusted|verified)\b/g },

  // --- role and tool-call mimicry --------------------------------------------------------------
  { id: 'chat-template-system', kind: 'role', weight: 1.5, example: 0.5, re: /<\|im_start\|>\s*system|<\|start_header_id\|>\s*system|<<sys>>\s*\S/g },
  { id: 'chat-template-token', kind: 'role', weight: 1, example: 0.5, re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text)\|>|\[\/?inst\]|<<\/?sys>>/g },
  { id: 'system-tag', kind: 'role', weight: 1.5, example: 0.5, re: /<\/?(?:system|system[_-]prompt|system[_-]message|instructions|admin|developer[_-]instructions|sudo|important[_-]instructions)>/g },
  { id: 'fake-tool-call', kind: 'role', weight: 2, example: 0.5, re: /<\/?(?:function_calls|invoke\s+name=|tool_use|tool_call|tool_result|function_results|antml:[a-z_]+)\b/g },
  { id: 'system-line', kind: 'role', weight: 1, example: 0.25, re: /(?:^|\n)[ \t]*(?:[#>*]+[ \t]*)?\[?(?:system|developer)(?: prompt| message| instructions?| override| notice)?\]?\s*:\s*(?:you\b|ignore|disregard|from now|always|never|new)/g },
  { id: 'chat-turns', kind: 'role', weight: 1, example: 0.25, re: /(?:^|\n)[ \t]*(?:human|user)[ \t]*:[ \t]*[^\n]+\n[\n \t]{0,4}(?:assistant|ai)[ \t]*:[ \t]*[^\n]+/g },
];

/** Words before a match that make it a description ("the model may ignore...") rather than an order. */
const DESCRIPTIVE_BEFORE = /\b(?:will|may|might|can|could|would|to|not|it|that|which|models?|llms?|they|often|sometimes|cannot|can't|won't|doesn't|don't|didn't|does|trying|tries|try|attempts?|attackers?|injections?|prompts?|e\.g\.|example|such as|like|says?|said|asks?)\s*[,:]?\s*$/;

const ACTION: ReadonlySet<Kind> = new Set<Kind>(['override', 'secrecy', 'secret', 'exfil', 'shell', 'tool', 'steer']);

/** Common Cyrillic and Greek lookalikes of Latin letters, for matching only. */
const CONFUSABLE: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', һ: 'h', ԛ: 'q', ԝ: 'w', ɡ: 'g',
  α: 'a', ο: 'o', ν: 'v', ι: 'i', κ: 'k', τ: 't', υ: 'u', ρ: 'p', ε: 'e', ѵ: 'v', ℓ: 'l',
};

/** Lowercased, compatibility-folded (fullwidth and math letters), lookalikes mapped, quotes straightened. */
export function skeleton(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u{0370}-\u{052F}\u{0261}]/gu, (c) => CONFUSABLE[c] ?? c)
    .replace(/[\u{2018}\u{2019}\u{02BC}]/gu, "'")
    .replace(/[\u{201C}\u{201D}]/gu, '"');
}

interface Hit {
  id: string;
  kind: Kind;
  weight: number;
  index: number;
  /** In prose, not quoted, not descriptive. */
  direct: boolean;
}

function quotedAt(line: string, col: number): boolean {
  const before = line.slice(0, col);
  // Straight quotes and backticks only: the skeleton already folded curly quotes.
  return ((before.match(/["`]/g) ?? []).length % 2) === 1;
}

function lineAround(text: string, index: number): { line: string; col: number } {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return { line: text.slice(start, end === -1 ? undefined : end), col: index - start };
}

function hitsIn(segment: string, skel: string, code: boolean, offset: number): Hit[] {
  const hits: Hit[] = [];
  for (const r of RULES) {
    const src = r.raw ? segment : skel;
    r.re.lastIndex = 0;
    for (const m of src.matchAll(r.re)) {
      const index = m.index ?? 0;
      const { line, col } = lineAround(src, index);
      const descriptive = Boolean(r.imperative) && DESCRIPTIVE_BEFORE.test(line.slice(Math.max(0, col - 40), col));
      // Text that addresses an agent counts wherever it sits; other rules weigh less in code and quotes.
      const example = descriptive || (r.kind !== 'agent' && (code || quotedAt(line, col)));
      const weight = example ? (r.example ?? r.weight * 0.5) : r.weight;
      hits.push({ id: r.id, kind: r.kind, weight, index: offset + index, direct: !example });
    }
  }
  return hits;
}

const B64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{60,}={0,2}(?![A-Za-z0-9+/=])/g;

/** Long base64 in prose: decode it and scan what it says. */
function encodedHits(prose: string, offset: number, depth: number): Hit[] {
  const out: Hit[] = [];
  for (const m of prose.matchAll(B64)) {
    const blob = m[0];
    let decoded = '';
    try {
      decoded = Buffer.from(blob, 'base64').toString('utf8');
    } catch {
      continue;
    }
    const printable = decoded.replace(/[^\x20-\x7e\n\t]/g, '').length / Math.max(1, decoded.length);
    if (printable > 0.9 && /[a-z]{3,}\s+[a-z]{3,}/i.test(decoded) && depth < 1) {
      const inner = scanText(decoded, { depth: depth + 1 });
      if (inner.level !== 'none') {
        out.push({ id: 'encoded-instructions', kind: 'encoded', weight: 3, index: offset + (m.index ?? 0), direct: true });
        continue;
      }
    }
    if (blob.length >= 200) out.push({ id: 'base64-blob-in-prose', kind: 'encoded', weight: 0.5, index: offset + (m.index ?? 0), direct: true });
  }
  return out;
}

/** For bench/injection/redos.ts. */
export const RULE_PATTERNS: readonly { id: string; re: RegExp; raw?: boolean }[] = RULES;

const EXFIL_IMAGE = RULES.find((r) => r.id === 'exfil-image') as Rule;

/** An image whose URL would carry data out when rendered. Checked on whole files, before images are tidied away. */
export function hasExfilImage(text: string): boolean {
  EXFIL_IMAGE.re.lastIndex = 0;
  return splitFences(text).some((s) => !s.code && new RegExp(EXFIL_IMAGE.re.source).test(s.text));
}

const NEAR = 800;

function judge(hits: Hit[]): ScanResult {
  if (!hits.length) return { level: 'none', reasons: [], score: 0 };
  // One rule counts once: a page that explains a chat template mentions its tokens many times.
  // The override rules overlap (several match "ignore previous instructions"): they count once together.
  const best = new Map<string, number>();
  for (const h of hits) {
    const k = h.kind === 'override' ? 'override' : h.id;
    best.set(k, Math.max(best.get(k) ?? 0, h.weight));
  }
  const score = [...best.values()].reduce((a, w) => a + w, 0);
  const agents = hits.filter((h) => h.kind === 'agent' && h.direct);
  const actions = hits.filter((h) => ACTION.has(h.kind));
  const combo = agents.some((a) => actions.some((x) => Math.abs(x.index - a.index) <= NEAR && x.id !== a.id));
  const strong = hits.some((h) => h.weight >= 3);
  const level: Level = strong || combo || score >= 4.5 ? 'high' : score >= 1.5 || agents.length ? 'medium' : 'none';
  const reasons = [...new Set([...hits].filter((h) => h.weight > 0).sort((a, b) => b.weight - a.weight).map((h) => h.id))];
  if (combo) reasons.unshift('addresses-agent-with-action');
  return { level, reasons: [...new Set(reasons)], score };
}

/**
 * Scans a passage. `code` treats the whole text as code (type definitions are
 * scanned as prose, since their doc comments are where text would hide);
 * `hidden` is what normalize() removed from it.
 */
export function scanText(text: string, opts: { code?: boolean; hidden?: HiddenText[]; depth?: number } = {}): ScanResult {
  const hits: Hit[] = [];
  let offset = 0;
  const segments = opts.code ? [{ code: true, text }] : splitFences(text);
  for (const s of segments) {
    hits.push(...hitsIn(s.text, skeleton(s.text), s.code, offset));
    if (!s.code) hits.push(...encodedHits(s.text, offset, opts.depth ?? 0));
    offset += s.text.length + 1;
  }
  for (const h of opts.hidden ?? []) hits.push(...hiddenHits(h));
  return judge(hits);
}

/** Hidden text is judged on its own: any instruction-like content in it is high. */
function hiddenHits(h: HiddenText): Hit[] {
  if (h.kind === 'unicode-tags') return [{ id: 'hidden-unicode-tags', kind: 'hidden', weight: 3, index: -1, direct: true }];
  if (h.kind === 'variation-selectors') return [{ id: 'variation-selector-payload', kind: 'hidden', weight: 1.5, index: -1, direct: true }];
  if (h.kind === 'zero-width-run') return [{ id: 'zero-width-payload', kind: 'hidden', weight: 1.5, index: -1, direct: true }];
  const inner = scanText(h.text);
  if (inner.level === 'none' && inner.score < 1) return [];
  return [{ id: `instructions-in-${h.kind}`, kind: 'hidden', weight: 3, index: -1, direct: true }];
}
