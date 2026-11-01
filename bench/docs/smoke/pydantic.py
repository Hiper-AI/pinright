# Runtime smoke test for the pydantic2-models task. Runs inside the agent's
# project with its own venv; prints one JSON line: tests and Pydantic deprecations.
import datetime
import json
import sys
import types
import warnings

sys.path.insert(0, ".")
res = []


def t(name, fn):
    try:
        res.append({"name": name, "pass": bool(fn())})
    except Exception as e:  # noqa: BLE001
        res.append({"name": name, "pass": False, "error": f"{type(e).__name__}: {str(e)[:160]}"})


def raises(fn):
    try:
        fn()
    except Exception:  # noqa: BLE001
        return True
    return False


with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    try:
        import models as m
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"tests": [{"name": "import", "pass": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}], "deprecations": []}))
        sys.exit(0)
    good = {"id": 1, "username": "ab_c1", "email": "A@B.CO", "tags": ["x"]}
    t("parse+lowercase", lambda: m.parse_user(good).email == "a@b.co")
    t("username-pattern", lambda: raises(lambda: m.parse_user({**good, "username": "AB"})))
    t("tags-min-1", lambda: raises(lambda: m.parse_user({**good, "tags": []})))
    t("extra-forbidden", lambda: raises(lambda: m.parse_user({**good, "extra": 1})))

    def frozen():
        u = m.parse_user(good)
        return raises(lambda: setattr(u, "id", 2))

    t("frozen", frozen)
    t("to-dict", lambda: m.user_to_dict(m.parse_user(good))["username"] == "ab_c1")
    t("to-json", lambda: json.loads(m.user_to_json(m.parse_user(good)))["id"] == 1)
    t("from-attributes", lambda: m.user_from_obj(types.SimpleNamespace(**good, nickname=None)).username == "ab_c1")
    now = datetime.datetime(2026, 1, 1)
    t("booking-ok", lambda: m.Booking(start=now, end=now + datetime.timedelta(hours=1)) is not None)
    t("booking-end-before-start", lambda: raises(lambda: m.Booking(start=now, end=now)))

deps = sorted({f"{type(w.message).__name__}: {str(w.message)[:120]}" for w in caught if type(w.message).__name__.startswith("PydanticDeprecated")})
print(json.dumps({"tests": res, "deprecations": deps}))
