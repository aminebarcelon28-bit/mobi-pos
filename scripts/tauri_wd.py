"""Minimal WebDriver client (no selenium) for tauri-driver sessions."""
import requests

DRIVER = "http://127.0.0.1:4444"


class WD:
    def __init__(self, session_id):
        self.sid = session_id
        self.base = f"{DRIVER}/session/{session_id}"

    def _req(self, method, path, body=None):
        r = requests.request(method, self.base + path, json=body, timeout=30)
        r.raise_for_status()
        data = r.json()
        return data.get("value")

    @classmethod
    def start(cls, app=r"C:\Users\Click\Desktop\phone3-sync-lab\target\debug\mobi-pos.exe"):
        r = requests.post(f"{DRIVER}/session", json={
            "capabilities": {"alwaysMatch": {"tauri:options": {"application": app}}}
        }, timeout=120)
        r.raise_for_status()
        data = r.json()
        return cls(data.get("sessionId") or data["value"]["sessionId"])

    def quit(self):
        try:
            requests.delete(self.base, timeout=10)
        except Exception:
            pass

    def title(self):
        return self._req("GET", "/title")

    def screenshot(self, path):
        import base64
        raw = self._req("GET", "/screenshot")
        with open(path, "wb") as f:
            f.write(base64.b64decode(raw))
        print(f"[wd] shot -> {path}")

    @staticmethod
    def _eid(el):
        if isinstance(el, dict):
            for k, v in el.items():
                if k.lower().startswith("element"):
                    return v
            return el.get("ELEMENT") or el.get("element")
        return el

    def find(self, css):
        return self._eid(self._req("POST", "/element", {"using": "css selector", "value": css}))

    def finds(self, css):
        return [self._eid(e) for e in (self._req("POST", "/elements", {"using": "css selector", "value": css}) or [])]

    def el_text(self, eid):
        return self._req("GET", f"/element/{eid}/text")

    def attr(self, eid, name):
        try:
            return self._req("GET", f"/element/{eid}/attribute/{name}")
        except Exception:
            return None

    def tag(self, eid):
        try:
            return self._req("GET", f"/element/{eid}/name")
        except Exception:
            return None

    def click(self, eid):
        self._req("POST", f"/element/{eid}/click", {})

    def execute(self, script, args=None):
        return self._req("POST", "/execute/sync", {"script": script, "args": args or []})

    @staticmethod
    def _ref(eid):
        return {
            "element-6066-11e4-a52c-e69b4b87d0ba5": eid,
            "element-6066-11e4-a52e-4f735466cecf": eid,
            "ELEMENT": eid,
        }

    def jsclick(self, eid):
        self.execute(
            "const el = arguments[0]; el.scrollIntoView({block:'center', inline:'center'});"
            " return (el.innerText || el.textContent || '').slice(0,60);",
            [self._ref(eid)],
        )
        import time as _t
        _t.sleep(0.4)
        self.execute("arguments[0].click();", [self._ref(eid)])

    def clear_type(self, eid, text):
        self._req("POST", f"/element/{eid}/clear", {})
        self._req("POST", f"/element/{eid}/value", {"text": text})

    def keys(self, eid, text):
        self._req("POST", f"/element/{eid}/value", {"text": text})

    def findx(self, xpath):
        return self._eid(self._req("POST", "/element", {"using": "xpath", "value": xpath}))

    def findsx(self, xpath):
        return [self._eid(e) for e in (self._req("POST", "/elements", {"using": "xpath", "value": xpath}) or [])]

    def get_attr_js(self, eid, attr):
        return self.execute(
            "const el = arguments[0]; return el.getAttribute(arguments[1]);",
            [self._ref(eid), attr],
        )

    def texts_of(self, css, limit=60):
        out = []
        for eid in self.finds(css)[:limit]:
            try:
                out.append(self.el_text(eid))
            except Exception:
                pass
        return out
