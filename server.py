from __future__ import annotations

import json
import mimetypes
import posixpath
import re
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
THREAD_DIR = ROOT / "threads"
ASSET_DIR = ROOT / "assets"
PROFILE_PATH = ROOT / "profile.json"
HOST = "127.0.0.1"
PORT = 5173
DESIGN_CSS = ROOT / "designs" / "design-1.css"
ALLOWED_IMAGE_TYPES = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def thread_path(thread_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", thread_id):
        raise ValueError("Invalid thread id")
    return THREAD_DIR / f"{thread_id}.json"


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, data: dict) -> None:
    THREAD_DIR.mkdir(exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write("\n")


def normalize_thread(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Thread must be an object")
    if not isinstance(data.get("id"), str) or not data["id"]:
        raise ValueError("Thread id is required")
    if not isinstance(data.get("messages"), list) or not data["messages"]:
        raise ValueError("Thread messages are required")
    return data


def default_profile() -> dict:
    return {"name": "Sam's Notes", "imageUrl": ""}


def normalize_profile(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Profile must be an object")

    name = data.get("name", default_profile()["name"])
    image_url = data.get("imageUrl", "")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Profile name is required")
    if not isinstance(image_url, str):
        raise ValueError("Profile image URL must be a string")
    if image_url and not image_url.startswith("/assets/"):
        raise ValueError("Profile image must be a local asset")
    return {"name": name.strip(), "imageUrl": image_url}


def safe_asset_name(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError("Invalid asset name")
    return name


class ThreadNotesHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        relative = posixpath.normpath(unquote(parsed.path)).lstrip("/")
        if not relative:
            relative = "index.html"
        resolved = (ROOT / relative).resolve()
        if ROOT not in resolved.parents and resolved != ROOT:
            return str(ROOT / "index.html")
        return str(resolved)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/threads":
            self.send_threads()
            return
        if parsed.path == "/api/profile":
            self.send_profile()
            return
        if parsed.path == "/design.css":
            self.send_design_css()
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/threads":
            self.create_thread()
            return
        if parsed.path == "/api/profile":
            self.update_profile()
            return
        if parsed.path == "/api/assets":
            self.create_asset()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        thread_id = self.thread_id_from_path()
        if thread_id:
            self.update_thread(thread_id)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        thread_id = self.thread_id_from_path()
        if thread_id:
            self.delete_thread(thread_id)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def guess_type(self, path: str) -> str:
        if path.endswith(".js"):
            return "text/javascript"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def thread_id_from_path(self) -> str | None:
        parsed = urlparse(self.path)
        prefix = "/api/threads/"
        if not parsed.path.startswith(prefix):
            return None
        return unquote(parsed.path[len(prefix):])

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def send_json(self, data: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_threads(self) -> None:
        THREAD_DIR.mkdir(exist_ok=True)
        threads = []
        for path in sorted(THREAD_DIR.glob("*.json")):
            try:
                threads.append(read_json(path))
            except json.JSONDecodeError:
                continue
        threads.sort(key=lambda thread: thread.get("updatedAt", ""), reverse=True)
        self.send_json({"threads": threads})

    def send_design_css(self) -> None:
        body = DESIGN_CSS.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/css; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_profile(self) -> None:
        if PROFILE_PATH.exists():
            try:
                self.send_json({"profile": normalize_profile(read_json(PROFILE_PATH))})
                return
            except (json.JSONDecodeError, ValueError):
                pass
        self.send_json({"profile": default_profile()})

    def create_thread(self) -> None:
        try:
            thread = normalize_thread(self.read_body())
            path = thread_path(thread["id"])
            if path.exists():
                self.send_error(HTTPStatus.CONFLICT, "Thread already exists")
                return
            write_json(path, thread)
            self.send_json({"thread": thread}, HTTPStatus.CREATED)
        except (json.JSONDecodeError, ValueError) as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def create_asset(self) -> None:
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        extension = ALLOWED_IMAGE_TYPES.get(content_type)
        if not extension:
            self.send_error(HTTPStatus.BAD_REQUEST, "Only gif, jpeg, png, and webp images are supported")
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self.send_error(HTTPStatus.BAD_REQUEST, "Image body is required")
            return
        if length > 10 * 1024 * 1024:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Image must be 10 MB or smaller")
            return

        ASSET_DIR.mkdir(exist_ok=True)
        filename = f"{uuid.uuid4().hex}{extension}"
        path = ASSET_DIR / safe_asset_name(filename)
        with path.open("wb") as file:
            file.write(self.rfile.read(length))
        self.send_json({"url": f"/assets/{filename}", "name": filename}, HTTPStatus.CREATED)

    def update_profile(self) -> None:
        try:
            profile = normalize_profile(self.read_body())
            with PROFILE_PATH.open("w", encoding="utf-8") as file:
                json.dump(profile, file, indent=2, ensure_ascii=False)
                file.write("\n")
            self.send_json({"profile": profile})
        except (json.JSONDecodeError, ValueError) as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def update_thread(self, thread_id: str) -> None:
        try:
            thread = normalize_thread(self.read_body())
            if thread["id"] != thread_id:
                self.send_error(HTTPStatus.BAD_REQUEST, "Thread id mismatch")
                return
            write_json(thread_path(thread_id), thread)
            self.send_json({"thread": thread})
        except (json.JSONDecodeError, ValueError) as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def delete_thread(self, thread_id: str) -> None:
        try:
            path = thread_path(thread_id)
            if path.exists():
                path.unlink()
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))


def main() -> None:
    THREAD_DIR.mkdir(exist_ok=True)
    ASSET_DIR.mkdir(exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), ThreadNotesHandler)
    print(f"Serving Sam's Notes at http://localhost:{PORT}")
    print(f"Thread files: {THREAD_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
