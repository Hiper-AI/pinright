# Runtime smoke test for the langchain1-agent task: the agent builds offline and
# exposes the two tools. Prints one JSON line.
import json
import os
import sys
import warnings

os.environ.setdefault("OPENAI_API_KEY", "sk-bench-not-a-real-key")
sys.path.insert(0, ".")
res = []


def t(name, fn):
    try:
        res.append({"name": name, "pass": bool(fn())})
    except Exception as e:  # noqa: BLE001
        res.append({"name": name, "pass": False, "error": f"{type(e).__name__}: {str(e)[:200]}"})


with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    try:
        import agent as mod
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"tests": [{"name": "import", "pass": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}], "deprecations": []}))
        sys.exit(0)
    built = {}

    def build():
        built["a"] = mod.build_agent()
        return hasattr(built["a"], "invoke")

    t("build_agent", build)
    t("ask-callable", lambda: callable(getattr(mod, "ask", None)))

    def tools_bound():
        nodes = built["a"].get_graph().nodes
        return "tools" in nodes

    t("tools-node", tools_bound)

deps = sorted({f"{w.category.__name__}: {str(w.message)[:120]}" for w in caught if issubclass(w.category, DeprecationWarning) and "langchain" in str(w.message).lower() + w.filename.lower()})
print(json.dumps({"tests": res, "deprecations": deps}))
