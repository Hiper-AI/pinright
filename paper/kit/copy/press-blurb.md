# Press blurb

## English (3 sentences)

Hiper AI released pinright, an open-source (MIT) tool that checks the dependencies a coding agent adds
against public advisory and malware data and gives the agent documentation for the exact version it
installs. In Hiper AI's benchmark with three Claude models on 12 coding tasks, 40% to 42% of the
direct dependencies the agents pinned without tools had a known advisory; with the pinright MCP server none did, and
alerts across the projects' dependency trees fell from 715 to 766 per model to 6, all six from one
upstream package with no fix published (docs for the current release alone, with the verdict off,
got to between 6 and 84). pinright runs
locally as an MCP server, a command-line tool, a pre-install hook for six coding agents and a GitHub
Action, with no account and no telemetry, and its benchmark data and limits are published with the code.

## Español (3 oraciones)

Hiper AI publicó pinright, una herramienta de código abierto (MIT) que revisa las dependencias que agrega
un agente de código contra datos públicos de avisos de seguridad y malware, y le da al agente la
documentación de la versión exacta que instala. En el benchmark de Hiper AI con tres modelos de Claude
en 12 tareas de programación, entre el 40% y el 42% de las dependencias directas que fijaron los
agentes sin herramientas tenía un aviso conocido; con el servidor MCP de pinright, ninguna, y las alertas en el árbol de
dependencias bajaron de entre 715 y 766 por modelo a 6. pinright corre en la máquina del usuario como
servidor MCP, herramienta de línea de comandos, hook previo a la instalación para seis agentes y GitHub
Action, sin cuenta ni telemetría, y los datos del benchmark y sus límites se publican junto con el código.
