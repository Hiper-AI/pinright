# Social posts

Character counts are for the text inside each block, counted with the link as written.

## X, English (thread of 4)

```
Coding agents pin dependency versions from memory. We tested Claude Code (Sonnet, Haiku, Opus 5.5) on 12 tasks: without tools, 40-42% of the direct deps they pinned had known advisories.

pinright checks each pick and serves docs for the version installed. MIT. npx pinright init
```

```
What helped most: steering the agent to current versions. pinright with its security layer off (docs for the latest release only) cut alerts from 715-766 to 84, 63 and 6 per model.

The full verdict took every model to 6 (one upstream with no fix) and 0 vulnerable direct pins.
```

```
The hook covers agents that never ask: it reads installs and manifest writes first. On 25,077 public commands it blocked or asked 1.46%, mostly on purpose.

One vendor, two days of advisory data, tasks we wrote. Report and data: github.com/Hiper-AI/pinright
```

```
Two limits we measured. Agents with a shell ran npm view first and every arm tied at 6 alerts: there pinright changed nothing.

Against pinright with its security layer off, the full server used 21-33% fewer tokens per run. No tools at all used fewer.
```

## X, español (hilo de 4)

```
Los agentes de código fijan versiones de memoria. Probamos Claude Code con Sonnet, Haiku y Opus 5.5 en 12 tareas: sin herramientas, el 40-42% de las dependencias directas tenía avisos de seguridad conocidos.

pinright revisa cada una y da docs de la versión que se instala. MIT.
```

```
Lo que más ayudó: llevar al agente a versiones nuevas. pinright sin su capa de seguridad (solo docs de la última versión) bajó las alertas de 715-766 a 84, 63 y 6 por modelo.

Con el veredicto, los tres quedaron en 6 (un paquete sin arreglo) y 0 dependencias directas vulnerables.
```

```
El hook cubre al agente que no pregunta: lee instalaciones y escrituras de manifiestos antes de que corran. En 25.077 comandos públicos bloqueó o preguntó en el 1,46%, casi siempre a propósito.

Un proveedor, dos días de datos, tareas nuestras. github.com/Hiper-AI/pinright
```

```
Dos límites medidos. Con shell, los agentes usaron npm view y todos los brazos quedaron en 6 alertas: ahí pinright no cambió nada.

Contra pinright sin su capa de seguridad, el servidor completo usó 21-33% menos tokens por corrida. Sin herramientas, menos aún.
```

## LinkedIn, English

```
Coding agents pick dependency versions from what their model remembers, and those versions are often a year or two old.

We measured it before shipping anything. Claude Code with Sonnet 5.5, Haiku 5.5 and Opus 5.5, 12 tasks we wrote, two runs each, every project audited with npm audit or pip-audit. Without tools, 40% to 42% of the direct dependencies each model pinned had a known advisory, and projects averaged about 30 alerts across their dependency trees.

Today we are releasing pinright, open source under MIT. It gives the agent a verdict on each dependency (OSV and deps.dev advisories, malware records, lookalike names, packages that do not exist) and docs taken from the package at the version it installs. A pre-install hook covers the agents that never ask.

What we learned: most of the gain comes from steering the agent to current versions. With its security layer off, pinright already cut alerts from 715-766 to 84, 63 and 6 per model. The verdict removed the rest: 6 alerts per model, all in one upstream package with no fix yet, and no vulnerable direct pins.

Two results limit that. When the agents had a shell, they looked versions up with npm view or pip index versions, and every arm, with or without pinright, ended at the same 6 alerts. And against pinright with its security layer off, the full server used 21% to 33% fewer tokens per run; no tools at all used fewer than either.

The limits are in the report: one model vendor, two days of advisory data, tasks we wrote. The hook reads commands; it does not sandbox anything.

npx pinright init
github.com/Hiper-AI/pinright
```

## LinkedIn, español

```
Los agentes de código eligen versiones de dependencias según lo que recuerda su modelo, y esas versiones suelen tener uno o dos años.

Lo medimos antes de publicar nada. Claude Code con Sonnet 5.5, Haiku 5.5 y Opus 5.5, 12 tareas escritas por nosotros, dos corridas cada una, cada proyecto auditado con npm audit o pip-audit. Sin herramientas, entre el 40% y el 42% de las dependencias directas que fijó cada modelo tenía un aviso de seguridad conocido, y los proyectos promediaron unas 30 alertas en su árbol de dependencias.

Hoy publicamos pinright, de código abierto con licencia MIT. Le da al agente un veredicto sobre cada dependencia (avisos de OSV y deps.dev, registros de malware, nombres parecidos a paquetes populares, paquetes que no existen) y documentación tomada del paquete en la versión que instala. Un hook previo a la instalación cubre a los agentes que no preguntan.

Lo que aprendimos: la mayor parte de la mejora viene de llevar al agente a versiones actuales. Con su capa de seguridad apagada, pinright ya bajó las alertas de 715-766 a 84, 63 y 6 por modelo. El veredicto sacó el resto: 6 alertas por modelo, todas de un paquete que todavía no tiene arreglo, y ninguna dependencia directa vulnerable.

Dos resultados acotan eso. Cuando los agentes tenían una shell, consultaron las versiones con npm view o pip index versions, y todos los brazos, con pinright o sin él, terminaron en las mismas 6 alertas. Y contra pinright sin su capa de seguridad, el servidor completo usó entre 21% y 33% menos tokens por corrida; sin herramientas se usan menos que con cualquiera de los dos.

Los límites están en el informe: un solo proveedor de modelos, dos días de datos de avisos, tareas nuestras. El hook lee comandos; no aísla nada.

npx pinright init
github.com/Hiper-AI/pinright
```
