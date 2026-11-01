**Retrieval probes: pinright's docs pipeline without an agent.** Share of questions whose answer
contains strings of the library's current API. Gray: the first score of each set, on the code it was
first scored on (original set at `e644213`, A and B at `dd570aa`, C at `d2f082a`). Blue: the release
candidate, rerun on 2026-11-01 on a cold cache (same as the end of the third docs round). Original
(the benchmark tasks, tuned on): 16 to 24 of 25. Held-out A (looked at while tuning): 53 to 75 of 81.
Held-out B (untouched): 22 to 25 of 28. Held-out C (untouched, written before round 3): 28 to 33 of
45. B and C are the numbers to quote. A probe checks for strings, not for a correct answer.

Source: `data/probes.csv`, `data/probes_heldout_questions.csv`; `bench/DOCS.md`.
Use: docs-quality evidence independent of the model. Files: `fig-d-retrieval-probes{,-dark}.{svg,png}`.
