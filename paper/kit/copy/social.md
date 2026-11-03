# Social posts

Character counts are for the text inside each block, counted with the links as written. X counts
every link as 23 characters; the counts below use the literal length, which is longer.

## X, English (thread of 4)

```
Coding agents pick dependency versions from memory, or from docs servers that do not check them. We tested Claude Code (Sonnet, Haiku, Opus 5.5) on 12 tasks: without tools, 40-42% of direct deps they pinned had known advisories.

pinright checks each pick first.
```

```
pinright gives the agent docs for the version it installs and a verdict on every dependency it adds: advisories, malware records, lookalike names, versions that do not exist.

With it: 0 vulnerable direct pins for all three models.

npx -y pinright init
```

```
Docs alone moved agents to current versions and cut most alerts. They still pinned a vulnerable next or next-auth in 4 of 72 runs (next@15.5.0: 32 advisories).

The verdict closed that, in 21-33% fewer tokens than the docs-only setup.
```

```
Limits we measured: with a shell, agents ran npm view first and every arm tied at 6 alerts. One vendor, two days of advisory data, tasks we wrote.

MIT, local, no account. Report and data: https://pinright.dev
```

## X, español (hilo de 4)

```
Los agentes de código eligen versiones de memoria, o de servidores de docs que no las revisan. Probamos Claude Code (Sonnet, Haiku y Opus 5.5) en 12 tareas: sin herramientas, el 40-42% de las dependencias directas tenía avisos de seguridad.

pinright las revisa antes.
```

```
pinright le da al agente docs de la versión que instala y un veredicto sobre cada dependencia: avisos de seguridad, malware, nombres parecidos, versiones que no existen.

Con pinright: 0 dependencias directas vulnerables en los tres modelos.

npx -y pinright init
```

```
Solo con docs, los agentes pasaron a versiones actuales y bajaron casi todas las alertas. Igual fijaron un next o next-auth vulnerable en 4 de 72 ejecuciones (next@15.5.0: 32 avisos).

El veredicto lo cerró con 21-33% menos tokens.
```

```
Límites medidos: con shell, los agentes consultaron npm view y todos los brazos empataron en 6 alertas. Un proveedor, dos días de datos, tareas nuestras.

MIT, local, sin cuenta. Informe y datos: https://pinright.dev/es/
```

## LinkedIn, English

```
Coding agents get dependency versions from two places: what their model remembers, or a docs server that returns documentation and does not check the version against advisories.

We measured both before shipping anything. Claude Code with Sonnet 5.5, Haiku 5.5 and Opus 5.5, 12 tasks we wrote, two runs each, every project audited with npm audit or pip-audit. From memory, 40% to 42% of the direct dependencies each model pinned had a known advisory, about 30 alerts per project. With current docs alone, alerts fell to 0.3 to 3.5 per project, and agents still pinned a vulnerable next or next-auth in 4 of 72 runs.

Today we are releasing pinright, open source under MIT. It gives the agent docs taken from the package at the version it installs, and a verdict on each dependency it adds: OSV and deps.dev advisories, malware records, lookalike names, versions that do not exist. A pre-install hook covers the agents that never ask. With pinright, all three models pinned no vulnerable direct dependency, and used 21% to 33% fewer tokens per run than the docs-only setup.

What limits the claim: when the agents had a shell, they looked versions up with npm view and every setup, with or without pinright, ended at the same 6 alerts. One model vendor, two days of advisory data, tasks we wrote. The hook reads commands; it does not sandbox anything.

npx -y pinright init
https://pinright.dev
```

## LinkedIn, español

```
Los agentes de código sacan las versiones de dos lugares: lo que recuerda su modelo, o un servidor de documentación que devuelve docs y no revisa la versión contra los avisos de seguridad.

Medimos los dos antes de publicar. Claude Code con Sonnet 5.5, Haiku 5.5 y Opus 5.5, 12 tareas nuestras, dos ejecuciones cada una, cada proyecto auditado con npm audit o pip-audit. De memoria, entre el 40% y el 42% de las dependencias directas que fijó cada modelo tenía un aviso de seguridad conocido, unas 30 alertas por proyecto. Solo con documentación actual, las alertas bajaron a 0,3 a 3,5 por proyecto, y los agentes igual fijaron un next o next-auth vulnerable en 4 de 72 ejecuciones.

Hoy publicamos pinright, de código abierto con licencia MIT. Le da al agente documentación tomada del paquete en la versión que instala y un veredicto sobre cada dependencia que agrega: avisos de OSV y deps.dev, registros de malware, nombres parecidos, versiones que no existen. Un hook previo a la instalación cubre a los agentes que no preguntan. Con pinright, ninguno de los tres modelos fijó una dependencia directa vulnerable, y usaron entre 21% y 33% menos tokens por ejecución que solo con documentación.

Lo que acota el resultado: cuando los agentes tenían una shell, consultaron las versiones con npm view y todas las configuraciones, con pinright o sin él, terminaron en las mismas 6 alertas. Un solo proveedor de modelos, dos días de datos de avisos, tareas nuestras. El hook lee comandos; no aísla nada.

npx -y pinright init
https://pinright.dev/es/
```

## Reddit

Post as a maker: say you built it, answer questions in the thread, and do not cross-post the same
text to several subreddits on the same day. Check each subreddit's self-promotion rule first.

### r/ClaudeAI (also fits r/cursor with the client list adjusted)

Title:

```
I measured how often Claude Code pins vulnerable dependency versions, and built an MCP server + hook to stop it (open source)
```

Body:

```
When Claude Code writes a package.json or requirements.txt, the version comes from memory (often a year or two old) or from a docs MCP server that does not check the version against advisories.

I measured it with Claude Code driving Sonnet 5.5, Opus 5.5 and Haiku 5.5 on 12 tasks (8 npm, 4 PyPI), two runs each, every project audited with npm audit / pip-audit:

- No tools: 40% to 42% of direct dependencies pinned had a known advisory, about 30 alerts per project.
- Docs for the current release only: 0.3 to 3.5 alerts per project, and a vulnerable next or next-auth in 4 of 72 runs.
- pinright: 0 vulnerable direct pins for all three models, with 21% to 33% fewer tokens than the docs-only setup.

pinright is an MCP server (check-packages, get-docs, upgrade-guide, check-manifest) plus a pre-install hook for Claude Code, Cursor, VS Code/Copilot, Codex, Gemini CLI and Windsurf. The hook reads installs and manifest writes before they run and denies a vulnerable pin with the version to use. Docs come from the published package and the repo at the release tag, so they match the version you install.

What limits the result: when the agents had a shell, they ran npm view before pinning and every setup tied at 6 alerts. One model vendor, two days of advisory data, tasks I wrote. Full method, data and caveats in the report.

Setup: npx -y pinright init
Site: https://pinright.dev
Repo: https://github.com/Hiper-AI/pinright (MIT, no account, no telemetry)

Happy to answer questions, and false-positive reports from the hook are very welcome.
```

### r/node

Title:

```
pinright: an MCP server and pre-install hook that checks the npm versions your coding agent pins (MIT)
```

Body:

```
Coding agents pin versions from memory. In my benchmark (Claude Code, three models, 12 tasks), 40% to 42% of the direct dependencies they pinned without tools had a known advisory; examples were axios@1.7.9 (33 advisories) and next@15.1.6 (36).

pinright checks each dependency the agent adds against OSV and deps.dev (advisories, malware records, typosquats, versions that do not exist) and suggests the clean version on the release line you already use. It also serves docs from the package at that version, and a hook stops `npm install x@bad` before it runs.

It also audits lockfiles (`pinright audit`, SARIF output, a GitHub Action). Local, no account, no telemetry.

npx -y pinright init
https://github.com/Hiper-AI/pinright
```
