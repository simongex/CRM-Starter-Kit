#!/usr/bin/env python3
"""Local preview server for the public site and internal platform.

Serves the static files and mirrors what Vercel does in production: the
/api endpoints plus the login gate on /internal.

    INTERNAL_USERS="alex:test,sam:test" python3 tools/dev-server.py
    open http://127.0.0.1:8765/internal

Production credentials live in Vercel environment variables, not here.
"""

import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.parse

PORT = int(os.environ.get("PORT", "8765"))
SESSION_MAX_SECONDS = 12 * 60 * 60
SESSION_SECONDS = SESSION_MAX_SECONDS
EMAIL_DOMAIN = "example.org"
LOGIN_PATH = "/internal/login"
STATE_FILE = ".dev-state.json"  # stands in for Vercel KV locally
CONTACTS_FILE = ".dev-contacts.json"
PASS_FILE = ".dev-passwords.json"
PROFILES_FILE = ".dev-profiles.json"
PASSKEY_FILE = ".dev-passkeys.json"
PASSKEY_LOCK = threading.Lock()
PASSKEY_TTL = 300
RESET_SECONDS = 30 * 60
RESET_TOKENS = {}
SESSION_EPOCH = {}
LOGIN_LIMIT = 5
LOGIN_WINDOW = 15 * 60
LOGIN_FAILS = {}

SEED_MEMBERS = [
    ("alex", "Alex Admin"),
    ("sam", "Sam Manager"),
    ("jordan", "Jordan Lee"),
    ("taylor", "Taylor Kim"),
    ("robin", "Robin Park"),
    ("casey", "Casey Lim"),
]

DEFAULT_CATEGORIES = [
    {"id": "donors", "name": "Donors", "color": "#d4b36a"},
    {"id": "institutional-funders", "name": "Institutional Funders", "color": "#7eb0d4"},
    {"id": "artists", "name": "Artists", "color": "#e08aa0"},
    {"id": "curators", "name": "Curators", "color": "#b39ddb"},
    {"id": "partner-organizations", "name": "Partner Organizations", "color": "#6cbcab"},
    {"id": "embassies", "name": "Embassies / Cultural Attachés", "color": "#e09a5a"},
    {"id": "press-media", "name": "Press / Media", "color": "#d0d0d0"},
    {"id": "board-advisors", "name": "Board Members / Advisors", "color": "#dcc87a"},
    {"id": "venues", "name": "Venues / Institutions", "color": "#5eb89a"},
    {"id": "academic", "name": "Academic", "color": "#8aa6d4"},
    {"id": "volunteers", "name": "Volunteers / Coordinators", "color": "#b5d47a"},
    {"id": "sponsors", "name": "Sponsors / Corporate", "color": "#d4a574"},
    {"id": "alumni", "name": "Alumni", "color": "#c49aaa"},
    {"id": "prospects", "name": "Prospects", "color": "#9a9a9a"},
]
PBKDF2_ITER = 100_000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAGES = {
    "/internal": "internal/index.html",
    "/internal/index.html": "internal/index.html",
    "/internal/login": "internal/login.html",
    "/internal/login.html": "internal/login.html",
    "/internal/reset": "internal/reset.html",
    "/internal/reset.html": "internal/reset.html",
}

REDIRECTS = {
    "/": "/internal",
    "/internal.html": "/internal",
    "/internal-login": "/internal/login",
    "/internal-login.html": "/internal/login",
}

PREFIXES = (
    ("/assets/", "website/assets/"),
    ("/styles/", "website/styles/"),
    ("/scripts/", "website/scripts/"),
)

ICONS = {
    "/favicon.ico": "website/assets/icons/favicon.ico",
    "/favicon-16x16.png": "website/assets/icons/favicon-16x16.png",
    "/favicon-32x32.png": "website/assets/icons/favicon-32x32.png",
    "/apple-touch-icon.png": "website/assets/icons/apple-touch-icon.png",
    "/android-chrome-192x192.png": "website/assets/icons/android-chrome-192x192.png",
    "/android-chrome-512x512.png": "website/assets/icons/android-chrome-512x512.png",
}

LEGACY = {
    "/internal.css": "internal/styles/app.css",
    "/internal.js": "internal/scripts/app.js",
    "/internal-data.js": "internal/scripts/data.js",
}


def is_workspace_route(path):
    return (
        path == "/internal/timeline"
        or path == "/internal/contacts"
        or path.startswith("/internal/contacts/")
    )


def is_protected(path):
    if path in {
        "/internal",
        "/internal.html",
        "/internal/index.html",
        "/internal.js",
        "/internal-data.js",
    }:
        return True
    if is_workspace_route(path):
        return True
    return path.startswith("/internal/scripts/") and not path.endswith(("/login.js", "/reset.js", "/passkey.js"))


def resolve_file(path):
    if is_workspace_route(path):
        return "internal/index.html"
    if path in PAGES:
        return PAGES[path]
    if path in ICONS:
        return ICONS[path]
    if path in LEGACY:
        return LEGACY[path]
    for prefix, folder in PREFIXES:
        if path.startswith(prefix):
            return folder + path[len(prefix):]
    page = os.path.join("website", path.lstrip("/") + ".html")
    if os.path.isfile(page):
        return page
    return path.lstrip("/")


def users():
    pairs = []
    for chunk in os.environ.get("INTERNAL_USERS", "").split(","):
        chunk = chunk.strip()
        if ":" in chunk:
            name, password = chunk.split(":", 1)
            if name.strip() and password:
                pairs.append((name.strip().lower(), password))
    return pairs


def secret():
    return os.environ.get("INTERNAL_SESSION_SECRET") or _PROCESS_SECRET


def parse_identity(value):
    raw = str(value or "").strip().lower()
    if "@" in raw:
        raw = raw.split("@", 1)[0]
    raw = re.sub(r"[^a-z0-9._-]", "", raw)
    return raw, f"{raw}@{EMAIL_DOMAIN}" if raw else ""


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


_PROCESS_SECRET = b64url(os.urandom(48))


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def sign(payload: str) -> str:
    mac = hmac.new(secret().encode(), payload.encode(), hashlib.sha256).digest()
    return b64url(mac)


def make_token(user: str, email: str, issued_at=None):
    now_ms = int(time.time() * 1000)
    iat = int(issued_at or now_ms)
    absolute_end = iat + SESSION_MAX_SECONDS * 1000
    if now_ms >= absolute_end:
        return "", 0
    exp = min(now_ms + SESSION_SECONDS * 1000, absolute_end)
    payload = b64url(
        json.dumps({"u": user, "email": email, "iat": iat, "e": exp}, separators=(",", ":")).encode()
    )
    return f"{payload}.{sign(payload)}", max(1, (exp - now_ms) // 1000)


def session_cookies(user: str, email: str, issued_at=None):
    token, max_age = make_token(user, email, issued_at)
    base = f"Path=/; Max-Age={max_age}; SameSite=Lax"
    return [
        f"kb_session={token}; HttpOnly; {base}",
        f"kb_user={urllib.parse.quote(user)}; {base}",
        f"kb_email={urllib.parse.quote(email)}; {base}",
    ]


def expired_cookies():
    expired = "Path=/; Max-Age=0; SameSite=Lax"
    return [
        f"kb_session=; HttpOnly; {expired}",
        f"kb_user=; {expired}",
        f"kb_email=; {expired}",
    ]


def read_claims(token: str):
    if not token or "." not in token or not secret():
        return None
    payload, signature = token.split(".", 1)
    if not hmac.compare_digest(sign(payload), signature):
        return None
    try:
        claims = json.loads(unb64url(payload))
    except Exception:
        return None
    now = time.time() * 1000
    exp = claims.get("e")
    iat = claims.get("iat")
    if not isinstance(exp, int) or exp <= now:
        return None
    if exp - now > SESSION_SECONDS * 1000 + 10_000:
        return None
    if not isinstance(iat, int) or iat > now + 10_000:
        return None
    if now - iat >= SESSION_MAX_SECONDS * 1000:
        return None
    if exp > iat + SESSION_MAX_SECONDS * 1000 + 10_000:
        return None
    user, email = parse_identity(claims.get("email") or claims.get("u") or "")
    if not user:
        return None
    since = SESSION_EPOCH.get(user)
    if since is not None and iat < since:
        return None
    return {"user": user, "email": email, "iat": iat}


def revoke_sessions(user: str):
    if user:
        SESSION_EPOCH[user] = int(time.time() * 1000)


def client_ip(handler):
    return re.sub(r"[^a-zA-Z0-9.:]", "", str(handler.client_address[0]))[:80]


def login_blocked(user: str, ip: str) -> bool:
    now = time.time()
    for key in (f"user:{user}", f"ip:{ip}"):
        stamps = [stamp for stamp in LOGIN_FAILS.get(key, []) if now - stamp < LOGIN_WINDOW]
        LOGIN_FAILS[key] = stamps
        if len(stamps) >= LOGIN_LIMIT:
            return True
    return False


def record_login_failure(user: str, ip: str):
    now = time.time()
    for key in (f"user:{user}", f"ip:{ip}"):
        stamps = [stamp for stamp in LOGIN_FAILS.get(key, []) if now - stamp < LOGIN_WINDOW]
        stamps.append(now)
        LOGIN_FAILS[key] = stamps


def clear_login_failures(user: str):
    LOGIN_FAILS.pop(f"user:{user}", None)


def load_passwords():
    try:
        with open(PASS_FILE) as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_passwords(data):
    with open(PASS_FILE, "w") as handle:
        json.dump(data, handle)


def hash_password(password: str):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITER)
    return {"salt": b64url(salt), "hash": b64url(digest), "iter": PBKDF2_ITER}


def verify_stored(password: str, record) -> bool:
    if not isinstance(record, dict) or "salt" not in record or "hash" not in record:
        return False
    salt = unb64url(record["salt"])
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, int(record.get("iter") or PBKDF2_ITER)
    )
    return hmac.compare_digest(b64url(digest), str(record["hash"]))


def same_text(a, b) -> bool:
    if not isinstance(a, str) or not isinstance(b, str) or len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def is_manager(user):
    return str(user or "").strip().lower() in ("alex", "sam")


MANAGER_CATEGORY_IDS = ("volunteers", "employees")


def manager_category_ids(categories):
    ids = set(MANAGER_CATEGORY_IDS)
    for cat in categories or []:
        if isinstance(cat, dict) and cat.get("managersOnly"):
            ids.add(cat.get("id"))
    return ids


def manager_only_contact(contact, ids):
    return any(cat in ids for cat in (contact or {}).get("categories") or [])


def contacts_state_for(state, manager):
    if manager or not isinstance(state, dict):
        return state
    ids = manager_category_ids(state.get("categories"))
    return {
        **state,
        "contacts": [c for c in state.get("contacts") or [] if not manager_only_contact(c, ids)],
        "sources": {"emails": {}, "notes": {}},
        "proposals": [],
        "dismissedInbound": [],
    }


def merge_team_contacts_edit(current, incoming):
    stored = current if isinstance(current, dict) else {}
    ids = manager_category_ids(stored.get("categories"))
    hidden = [c for c in stored.get("contacts") or [] if manager_only_contact(c, ids)]
    hidden_ids = {c.get("id") for c in hidden}
    sent = [
        {**c, "categories": [cat for cat in c.get("categories") or [] if cat not in ids]}
        for c in incoming.get("contacts") or []
        if isinstance(c, dict) and c.get("id") not in hidden_ids
    ]
    categories = [c for c in incoming.get("categories") or [] if c.get("id") not in ids]
    categories += [c for c in stored.get("categories") or [] if c.get("id") in ids]
    return {
        **incoming,
        "categories": categories,
        "contacts": sent + hidden,
        "sources": stored.get("sources") or {"emails": {}, "notes": {}},
        "proposals": stored.get("proposals") or [],
        "dismissedInbound": stored.get("dismissedInbound") or [],
    }


def owner_field_matches(user, owner):
    first = next((part for part in re.split(r"[^a-z]+", str(user or "").lower()) if part), "")
    return bool(first) and bool(re.search(rf"\b{re.escape(first)}\b", str(owner or ""), re.I))


def owns_task(user, task):
    return owner_field_matches(user, task.get("owner"))


def owns_action(user, task, action):
    return owner_field_matches(user, action.get("owner") or task.get("owner"))


def sees_task(user, task):
    return owns_task(user, task) or any(owns_action(user, task, a) for a in task.get("actions") or [])


def visible_doc(doc, user):
    if not doc.get("state") or is_manager(user):
        return doc
    tasks = [task for task in doc["state"].get("tasks", []) if sees_task(user, task)]
    return {**doc, "state": {**doc["state"], "tasks": tasks}}


def merge_collaborator_edits(current, incoming, user):
    visible = {task["id"] for task in current.get("tasks", []) if sees_task(user, task)}
    sent = {task.get("id"): task for task in incoming.get("tasks", [])}
    if set(sent) != visible:
        return None
    tasks = []
    for task in current.get("tasks", []):
        edit = sent.get(task["id"])
        if task["id"] not in visible:
            tasks.append(task)
        elif owns_task(user, task):
            tasks.append({**edit, "id": task["id"], "owner": task.get("owner")})
        else:
            before = task.get("actions") or []
            after = edit.get("actions") if isinstance(edit.get("actions"), list) else []
            if len(after) != len(before):
                return None
            actions = [
                {**after[i], "owner": action.get("owner")} if owns_action(user, task, action) else action
                for i, action in enumerate(before)
            ]
            tasks.append({**task, "actions": actions})
    return {**current, "tasks": tasks}


def load_profiles():
    try:
        with open(PROFILES_FILE) as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def member_directory():
    names = {user: name for user, name in SEED_MEMBERS}
    for user, profile in load_profiles().items():
        key = str(user or "").strip().lower()
        if not key or not isinstance(profile, dict):
            continue
        if key in names:
            continue
        name = str(profile.get("name") or "").strip()[:120]
        names[key] = name or (key[:1].upper() + key[1:])
    for user, _password in users():
        if user not in names:
            names[user] = user[:1].upper() + user[1:]
    for user in load_passwords():
        key = str(user or "").strip().lower()
        if key and key not in names:
            names[key] = key[:1].upper() + key[1:]
    seed_ids = [user for user, _name in SEED_MEMBERS]
    ordered = [user for user in seed_ids if user in names]
    ordered += sorted((user for user in names if user not in seed_ids), key=lambda user: names[user].lower())
    return [{"id": user, "name": names[user]} for user in ordered]


def empty_contacts():
    return {
        "categories": [dict(item) for item in DEFAULT_CATEGORIES],
        "contacts": [],
        "sources": {"emails": {}, "notes": {}},
        "suggestions": [],
        "proposals": [],
        "dismissedInbound": [],
        "lastSyncAt": "",
        "lastSummarizeAt": "",
    }


def integrations():
    gmail_ready = bool(os.environ.get("GMAIL_CLIENT_ID") and os.environ.get("GMAIL_CLIENT_SECRET"))
    return {
        "gmail": {"configured": gmail_ready, "connected": False, "email": ""},
        "granola": {"configured": bool(os.environ.get("GRANOLA_API_KEY"))},
        "anthropic": {"configured": bool(os.environ.get("ANTHROPIC_API_KEY"))},
        "mailchimp": {
            "configured": bool(
                os.environ.get("MAILCHIMP_API_KEY")
                and os.environ.get("MAILCHIMP_SERVER_PREFIX")
                and os.environ.get("MAILCHIMP_AUDIENCE_ID")
            )
        },
    }


def load_contacts_doc():
    try:
        with open(CONTACTS_FILE) as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            if not data.get("state"):
                data["state"] = empty_contacts()
            return data
    except Exception:
        pass
    return {"updatedAt": 0, "updatedBy": "", "state": empty_contacts()}


def password_matches(user: str, password: str) -> bool:
    stored = load_passwords().get(user)
    if stored:
        return verify_stored(password, stored)
    table = dict(users())
    if user in table:
        return same_text(table[user], password)
    return False


def account_exists(user: str) -> bool:
    if any(name == user for name, _password in users()):
        return True
    return user in load_passwords()


def load_passkeys():
    try:
        with open(PASSKEY_FILE) as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            data.setdefault("challenges", {})
            data.setdefault("credentials", {})
            return data
    except Exception:
        pass
    return {"challenges": {}, "credentials": {}}


def save_passkeys(data):
    with open(PASSKEY_FILE, "w") as handle:
        json.dump(data, handle)


def put_passkey_challenge(record):
    stored = dict(record)
    stored["exp"] = time.time() + PASSKEY_TTL
    challenge_id = b64url(os.urandom(32))
    with PASSKEY_LOCK:
        data = load_passkeys()
        now = time.time()
        data["challenges"] = {
            key: value for key, value in data["challenges"].items() if value.get("exp", 0) > now
        }
        data["challenges"][challenge_id] = stored
        save_passkeys(data)
    return challenge_id


def take_passkey_challenge(challenge_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,200}", str(challenge_id or "")):
        return None
    with PASSKEY_LOCK:
        data = load_passkeys()
        record = data["challenges"].pop(challenge_id, None)
        now = time.time()
        data["challenges"] = {
            key: value for key, value in data["challenges"].items() if value.get("exp", 0) > now
        }
        save_passkeys(data)
    if not record or record.get("exp", 0) <= time.time():
        return None
    return record


def request_party(handler):
    host = (handler.headers.get("Host") or f"127.0.0.1:{PORT}").split(",")[0].strip()
    proto = (handler.headers.get("X-Forwarded-Proto") or "http").split(",")[0].strip()
    hostname = host.split(":")[0].lower()
    return hostname, f"{proto}://{host}"


def decode_cbor(data, pos=0):
    major = data[pos] >> 5
    info = data[pos] & 31
    pos += 1
    if info < 24:
        length = info
    elif info == 24:
        length = data[pos]
        pos += 1
    elif info == 25:
        length = int.from_bytes(data[pos:pos + 2], "big")
        pos += 2
    elif info == 26:
        length = int.from_bytes(data[pos:pos + 4], "big")
        pos += 4
    else:
        raise ValueError("cbor")
    if major == 0:
        return length, pos
    if major == 1:
        return -1 - length, pos
    if major == 2:
        return bytes(data[pos:pos + length]), pos + length
    if major == 3:
        return data[pos:pos + length].decode(), pos + length
    if major == 4:
        items = []
        for _ in range(length):
            item, pos = decode_cbor(data, pos)
            items.append(item)
        return items, pos
    if major == 5:
        mapping = {}
        for _ in range(length):
            key, pos = decode_cbor(data, pos)
            value, pos = decode_cbor(data, pos)
            mapping[key] = value
        return mapping, pos
    raise ValueError("cbor")


def parse_auth_data(auth):
    if len(auth) < 37:
        raise ValueError("auth")
    flags = auth[32]
    parsed = {
        "rp_hash": auth[:32],
        "up": bool(flags & 1),
        "uv": bool(flags & 4),
        "sign_count": int.from_bytes(auth[33:37], "big"),
        "credential_id": b"",
        "cose": None,
    }
    if flags & 0x40:
        id_len = int.from_bytes(auth[53:55], "big")
        start = 55
        parsed["credential_id"] = auth[start:start + id_len]
        parsed["cose"], _pos = decode_cbor(auth, start + id_len)
    return parsed


def cose_coordinates(cose):
    if not isinstance(cose, dict) or cose.get(1) != 2 or cose.get(3) != -7 or cose.get(-1) != 1:
        raise ValueError("cose")
    x, y = cose.get(-2), cose.get(-3)
    if not isinstance(x, (bytes, bytearray)) or not isinstance(y, (bytes, bytearray)):
        raise ValueError("cose")
    if len(x) != 32 or len(y) != 32:
        raise ValueError("cose")
    return bytes(x), bytes(y)


P256_SPKI = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")


def der_int(raw):
    raw = raw.lstrip(b"\x00") or b"\x00"
    if raw[0] & 0x80:
        raw = b"\x00" + raw
    return b"\x02" + bytes([len(raw)]) + raw


def signature_der(signature):
    if signature[:1] == b"\x30":
        return signature
    if len(signature) != 64:
        raise ValueError("sig")
    body = der_int(signature[:32]) + der_int(signature[32:])
    return b"\x30" + bytes([len(body)]) + body


def verify_es256(x, y, message, signature):
    folder = tempfile.mkdtemp()
    try:
        pub = os.path.join(folder, "pub.der")
        pem = os.path.join(folder, "pub.pem")
        msg = os.path.join(folder, "msg.bin")
        sig_path = os.path.join(folder, "sig.der")
        with open(pub, "wb") as handle:
            handle.write(P256_SPKI + b"\x04" + x + y)
        with open(msg, "wb") as handle:
            handle.write(message)
        with open(sig_path, "wb") as handle:
            handle.write(signature_der(signature))
        made = subprocess.run(
            ["openssl", "pkey", "-pubin", "-inform", "DER", "-in", pub, "-out", pem],
            capture_output=True,
        )
        if made.returncode != 0:
            return False
        checked = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", pem, "-signature", sig_path, msg],
            capture_output=True,
        )
        return checked.returncode == 0
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def read_client_data(response, expected_type, challenge, origin):
    try:
        client = json.loads(unb64url(response.get("clientDataJSON") or ""))
    except Exception as error:
        raise ValueError("client") from error
    if client.get("type") != expected_type or client.get("challenge") != challenge or client.get("crossOrigin") is True:
        raise ValueError("client")
    if client.get("origin") != origin:
        raise ValueError("origin")
    return unb64url(response.get("clientDataJSON") or "")


def authenticator_bytes(response, expected_type):
    if expected_type == "webauthn.create":
        attestation, _pos = decode_cbor(unb64url(response.get("attestationObject") or ""))
        if not isinstance(attestation, dict) or attestation.get("fmt") not in ("none", "packed"):
            raise ValueError("fmt")
        auth = attestation.get("authData")
        if not isinstance(auth, (bytes, bytearray)):
            raise ValueError("auth")
        return bytes(auth)
    return unb64url(response.get("authenticatorData") or "")


def credential_id_from(credential):
    raw = unb64url(credential.get("rawId") or credential.get("id") or "")
    credential_id = b64url(raw)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,200}", credential_id):
        raise ValueError("id")
    return credential_id, raw


class Handler(http.server.SimpleHTTPRequestHandler):
    def cookie(self, name):
        header = self.headers.get("Cookie", "")
        for part in header.split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return ""

    def send_json(self, status, body, cookies=()):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return None

    def signed_in_identity(self):
        claims = read_claims(self.cookie("kb_session"))
        if not claims:
            return "", ""
        return claims["user"], claims["email"]

    def api_path(self):
        return urllib.parse.urlparse(self.path).path

    def handle_state(self):
        user, _email = self.signed_in_identity()
        if not user:
            return self.send_json(401, {"error": "Not signed in"})

        try:
            with open(STATE_FILE) as handle:
                current = json.load(handle)
        except Exception:
            current = {"updatedAt": 0, "updatedBy": "", "state": None}

        if self.command == "GET":
            return self.send_json(200, visible_doc(current, user))

        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request"})

        state = body.get("state")
        if not isinstance(state, dict) or "tasks" not in state or "phases" not in state:
            return self.send_json(400, {"error": "Bad request"})

        if str(current.get("updatedAt", 0)) != str(body.get("base", 0)):
            return self.send_json(409, visible_doc(current, user))

        before = current.get("state") or None
        if not is_manager(user):
            if not before:
                return self.send_json(403, {"error": "Only Alex and Sam can set up the timeline."})
            state = merge_collaborator_edits(before, state, user)
            if state is None:
                return self.send_json(403, {"error": "You can only edit your own tasks. Only Alex and Sam can add or delete tasks."})

        doc = {"updatedAt": int(time.time() * 1000), "updatedBy": user, "state": state}
        with open(STATE_FILE, "w") as handle:
            json.dump(doc, handle)
        return self.send_json(200, {"updatedAt": doc["updatedAt"], "updatedBy": user})

    def handle_session(self):
        claims = read_claims(self.cookie("kb_session"))
        if not claims:
            return self.send_json(401, {"error": "Not signed in"})
        return self.send_json(
            200,
            {"ok": True, "user": claims["user"], "email": claims["email"]},
            session_cookies(claims["user"], claims["email"], claims["iat"]),
        )

    def handle_password_reset(self):
        user, email = self.signed_in_identity()
        if not user:
            return self.send_json(401, {"error": "Not signed in"})
        token = b64url(os.urandom(32))
        RESET_TOKENS[token] = (user, time.time() + RESET_SECONDS)
        link = f"http://127.0.0.1:{PORT}/internal/reset?token={token}"
        print(f"Password reset link for {email}: {link}", flush=True)
        return self.send_json(200, {"ok": True, "email": email})

    def handle_password(self):
        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request"})

        token = str(body.get("token") or "")
        nxt = str(body.get("next") or "")
        if not token:
            return self.send_json(400, {"error": "This link is missing its code. Request a new one from your profile."})
        if len(nxt) < 8:
            return self.send_json(400, {"error": "Use at least 8 characters for the new password."})
        user, expires = RESET_TOKENS.pop(token, ("", 0))
        if not user or expires < time.time():
            return self.send_json(400, {"error": "This link has expired or was already used. Request a new one from your profile."})

        stored = load_passwords()
        stored[user] = hash_password(nxt)
        save_passwords(stored)
        revoke_sessions(user)
        return self.send_json(200, {"ok": True}, expired_cookies())

    def handle_profile(self):
        user, _email = self.signed_in_identity()
        if not user:
            return self.send_json(401, {"error": "Not signed in"})
        try:
            with open(PROFILES_FILE) as handle:
                profiles = json.load(handle)
        except Exception:
            profiles = {}
        if self.command == "GET":
            return self.send_json(200, {"profile": profiles.get(user, {})})
        body = self.read_body()
        if body is None or not isinstance(body.get("profile"), dict):
            return self.send_json(400, {"error": "Bad request"})
        profile = {
            key: str(value).strip()[:120]
            for key, value in body["profile"].items()
            if key in ("name", "email", "role", "team") and isinstance(value, str)
        }
        profiles[user] = profile
        with open(PROFILES_FILE, "w") as handle:
            json.dump(profiles, handle)
        return self.send_json(200, {"profile": profile})

    def contacts_refusal(self):
        user, _email = self.signed_in_identity()
        if not user:
            self.send_json(401, {"error": "Not signed in"})
            return True
        return False

    def gmail_refusal(self):
        return self.contacts_refusal()

    def handle_contacts(self):
        if self.contacts_refusal():
            return
        user, _email = self.signed_in_identity()
        manager = is_manager(user)

        current = load_contacts_doc()
        if self.command == "GET":
            return self.send_json(200, {
                **current,
                "state": contacts_state_for(current.get("state"), manager),
                "members": member_directory(),
                "integrations": integrations(),
            })

        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request"})
        state = body.get("state")
        if not isinstance(state, dict) or "contacts" not in state or "categories" not in state:
            return self.send_json(400, {"error": "Bad request"})
        if str(current.get("updatedAt", 0)) != str(body.get("base", 0)):
            return self.send_json(409, {
                **current,
                "state": contacts_state_for(current.get("state"), manager),
                "members": member_directory(),
                "integrations": integrations(),
            })

        doc = {
            "updatedAt": int(time.time() * 1000),
            "updatedBy": user,
            "state": state if manager else merge_team_contacts_edit(current.get("state"), state),
        }
        with open(CONTACTS_FILE, "w") as handle:
            json.dump(doc, handle)
        return self.send_json(200, {"updatedAt": doc["updatedAt"], "updatedBy": user})

    def handle_contacts_sync(self):
        if self.contacts_refusal():
            return
        user, _email = self.signed_in_identity()
        current = load_contacts_doc()
        return self.send_json(200, {
            **current,
            "state": contacts_state_for(current.get("state"), is_manager(user)),
            "members": member_directory(),
            "integrations": integrations(),
            "message": "Sync finished — no new matches",
            "result": {
                "written": 0,
                "errors": [],
            },
        })

    def handle_contacts_summarize(self):
        if self.contacts_refusal():
            return
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return self.send_json(501, {"error": "Set ANTHROPIC_API_KEY to generate relationship summaries."})
        return self.send_json(501, {"error": "Summary generation runs on the deployed API."})

    def handle_contacts_notes(self):
        if self.contacts_refusal():
            return
        return self.send_json(501, {"error": "Note generation runs on the deployed API."})

    def handle_contacts_catchup(self):
        if self.contacts_refusal():
            return
        return self.send_json(501, {"error": "Update notes runs on the deployed API."})

    def handle_gmail(self):
        if self.gmail_refusal():
            return
        return self.send_json(501, {
            "error": "Gmail OAuth runs on the deployed API. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Vercel."
        })

    def handle_desktop(self):
        user, _email = self.signed_in_identity()
        if not user:
            return self.send_json(401, {"error": "Not signed in"})
        folder = os.path.join(ROOT, "desktop", "dist")
        match = ""
        if os.path.isdir(folder):
            names = [name for name in os.listdir(folder) if name.endswith(".dmg")]
            names.sort(key=lambda name: (name != "YourOrg.dmg", name))
            if names:
                match = os.path.join(folder, names[0])
        if not match:
            return self.send_json(404, {"error": "The Mac app has not been built yet."})
        with open(match, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/x-apple-diskimage")
        self.send_header("Content-Disposition", 'attachment; filename="YourOrg.dmg"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_passkey(self):
        user, _email = self.signed_in_identity()
        if self.command == "GET":
            if not user:
                return self.send_json(401, {"error": "Not signed in"})
            with PASSKEY_LOCK:
                data = load_passkeys()
            count = sum(1 for record in data["credentials"].values() if record.get("user") == user)
            return self.send_json(200, {"count": count})

        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request"})
        step = body.get("step")
        rp_id, origin = request_party(self)
        ip = client_ip(self)
        bucket = f"passkey:{ip or 'unknown'}"

        try:
            if step in ("register-options", "register"):
                if not user:
                    return self.send_json(401, {"error": "Not signed in"})
                if step == "register-options":
                    challenge = b64url(os.urandom(32))
                    challenge_id = put_passkey_challenge({"kind": "register", "challenge": challenge, "user": user})
                    with PASSKEY_LOCK:
                        existing = [
                            cred_id for cred_id, record in load_passkeys()["credentials"].items()
                            if record.get("user") == user
                        ]
                    identity_user, identity_email = parse_identity(user)
                    return self.send_json(200, {
                        "challengeId": challenge_id,
                        "publicKey": {
                            "challenge": challenge,
                            "rp": {"name": "YourOrg", "id": rp_id},
                            "user": {
                                "id": b64url(identity_user.encode()),
                                "name": identity_email,
                                "displayName": identity_email,
                            },
                            "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
                            "timeout": 60000,
                            "attestation": "none",
                            "authenticatorSelection": {
                                "authenticatorAttachment": "platform",
                                "residentKey": "required",
                                "userVerification": "required",
                            },
                            "excludeCredentials": [{"type": "public-key", "id": cred_id} for cred_id in existing],
                        },
                    })

                stored = take_passkey_challenge(body.get("challengeId"))
                if not stored or stored.get("kind") != "register" or stored.get("user") != user:
                    return self.send_json(400, {"error": "That setup expired. Try again."})
                credential = body.get("credential") or {}
                credential_id, raw_id = credential_id_from(credential)
                response = credential.get("response") or {}
                read_client_data(response, "webauthn.create", stored["challenge"], origin)
                parsed = parse_auth_data(authenticator_bytes(response, "webauthn.create"))
                if parsed["rp_hash"] != hashlib.sha256(rp_id.encode()).digest() or not parsed["up"] or not parsed["uv"]:
                    return self.send_json(401, {"error": "Touch ID or Face ID did not confirm this device."})
                if parsed["credential_id"] != raw_id:
                    return self.send_json(400, {"error": "Could not save this device."})
                x, y = cose_coordinates(parsed["cose"])
                with PASSKEY_LOCK:
                    data = load_passkeys()
                    owned = [cred_id for cred_id, record in data["credentials"].items() if record.get("user") == user]
                    if credential_id not in owned and len(owned) >= 8:
                        return self.send_json(400, {"error": "This account already has a passkey on eight devices."})
                    data["credentials"][credential_id] = {
                        "user": user,
                        "x": b64url(x),
                        "y": b64url(y),
                        "counter": parsed["sign_count"],
                        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                    save_passkeys(data)
                return self.send_json(200, {"ok": True})

            if step == "login-options":
                if login_blocked(bucket, ip):
                    return self.send_json(429, {"error": "Too many sign-in attempts. Try again in 15 minutes."})
                challenge = b64url(os.urandom(32))
                challenge_id = put_passkey_challenge({"kind": "login", "challenge": challenge})
                return self.send_json(200, {
                    "challengeId": challenge_id,
                    "publicKey": {
                        "challenge": challenge,
                        "rpId": rp_id,
                        "timeout": 60000,
                        "userVerification": "required",
                    },
                })

            if step == "login":
                if login_blocked(bucket, ip):
                    return self.send_json(429, {"error": "Too many sign-in attempts. Try again in 15 minutes."})
                stored = take_passkey_challenge(body.get("challengeId"))
                if not stored or stored.get("kind") != "login":
                    return self.send_json(400, {"error": "That sign-in expired. Try again."})
                credential = body.get("credential") or {}
                try:
                    credential_id, _raw = credential_id_from(credential)
                    response = credential.get("response") or {}
                    client_data = read_client_data(response, "webauthn.get", stored["challenge"], origin)
                    auth = authenticator_bytes(response, "webauthn.get")
                    parsed = parse_auth_data(auth)
                except Exception:
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "This device is not set up for YourOrg."})
                with PASSKEY_LOCK:
                    record = load_passkeys()["credentials"].get(credential_id)
                if not record or not account_exists(record.get("user", "")):
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "This device is not set up for YourOrg."})
                identity_user, identity_email = parse_identity(record["user"])
                handle = response.get("userHandle")
                if handle and unb64url(handle).decode() != identity_user:
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "This device is not set up for YourOrg."})
                if parsed["rp_hash"] != hashlib.sha256(rp_id.encode()).digest() or not parsed["up"] or not parsed["uv"]:
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "Touch ID or Face ID did not confirm this sign-in."})
                signed = auth + hashlib.sha256(client_data).digest()
                if not verify_es256(unb64url(record["x"]), unb64url(record["y"]), signed, unb64url(response.get("signature") or "")):
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "Touch ID or Face ID did not confirm this sign-in."})
                if record["counter"] > 0 and parsed["sign_count"] > 0 and parsed["sign_count"] <= record["counter"]:
                    record_login_failure(bucket, ip)
                    return self.send_json(401, {"error": "Touch ID or Face ID did not confirm this sign-in."})
                with PASSKEY_LOCK:
                    data = load_passkeys()
                    if credential_id in data["credentials"]:
                        data["credentials"][credential_id]["counter"] = parsed["sign_count"]
                        save_passkeys(data)
                clear_login_failures(bucket)
                clear_login_failures(identity_user)
                return self.send_json(
                    200,
                    {"ok": True, "user": identity_user, "email": identity_email},
                    session_cookies(identity_user, identity_email),
                )
        except Exception:
            return self.send_json(400, {"error": "Could not use Touch ID or Face ID."})
        return self.send_json(400, {"error": "Bad request"})

    def do_PUT(self):
        path = self.api_path()
        if path == "/api/state":
            return self.handle_state()
        if path == "/api/password":
            return self.handle_password()
        if path == "/api/profile":
            return self.handle_profile()
        if path == "/api/contacts":
            return self.handle_contacts()
        return self.send_error(404)

    def do_POST(self):
        path = self.api_path()
        if path == "/api/state":
            return self.handle_state()
        if path == "/api/session":
            return self.handle_session()
        if path == "/api/password":
            return self.handle_password()
        if path == "/api/password-reset":
            return self.handle_password_reset()
        if path == "/api/profile":
            return self.handle_profile()
        if path == "/api/logout":
            claims = read_claims(self.cookie("kb_session"))
            if claims:
                revoke_sessions(claims["user"])
            return self.send_json(200, {"ok": True}, expired_cookies())
        if path == "/api/contacts":
            return self.handle_contacts()
        if path == "/api/contacts-sync":
            return self.handle_contacts_sync()
        if path == "/api/contacts-summarize":
            return self.handle_contacts_summarize()
        if path == "/api/contacts-notes":
            return self.handle_contacts_notes()
        if path == "/api/contacts-catchup":
            return self.handle_contacts_catchup()
        if path == "/api/passkey":
            return self.handle_passkey()

        if path != "/api/login":
            return self.send_error(404)

        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad request"})

        user, email = parse_identity(body.get("user") or body.get("email") or "")
        password = str(body.get("password", ""))
        if not user or not password:
            return self.send_json(400, {"error": "Enter your email and password."})
        if not users() and not load_passwords():
            return self.send_json(503, {"error": "Access is not configured yet."})
        ip = client_ip(self)
        if login_blocked(user, ip):
            return self.send_json(429, {"error": "Too many sign-in attempts. Try again in 15 minutes."})
        if not password_matches(user, password):
            record_login_failure(user, ip)
            return self.send_json(401, {"error": "That email and password did not match."})
        clear_login_failures(user)

        return self.send_json(
            200,
            {"ok": True, "user": user, "email": email},
            session_cookies(user, email),
        )

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        path = path.rstrip("/") or "/"
        query = urllib.parse.urlparse(self.path).query

        if path == "/api/state":
            return self.handle_state()
        if path == "/api/session":
            return self.handle_session()
        if path == "/api/contacts":
            return self.handle_contacts()
        if path == "/api/profile":
            return self.handle_profile()
        if path == "/api/gmail":
            return self.handle_gmail()
        if path == "/api/desktop":
            return self.handle_desktop()
        if path == "/api/passkey":
            return self.handle_passkey()

        if path in REDIRECTS:
            location = REDIRECTS[path]
            if query:
                location += "?" + query
            self.send_response(301)
            self.send_header("Location", location)
            self.end_headers()
            return

        if is_protected(path) and not read_claims(self.cookie("kb_session")):
            if path.endswith(".js"):
                self.send_response(401)
                self.end_headers()
                return
            self.send_response(302)
            self.send_header(
                "Location", f"{LOGIN_PATH}?to={urllib.parse.quote(path)}"
            )
            self.end_headers()
            return

        if path in ("/internal-data.js", "/internal/scripts/data.js"):
            user, _email = self.signed_in_identity()
            if not is_manager(user):
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        resolved = resolve_file(path)
        self.path = "/" + resolved
        if query:
            self.path += "?" + query
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    os.chdir(ROOT)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving http://127.0.0.1:{PORT}/")
        httpd.serve_forever()
