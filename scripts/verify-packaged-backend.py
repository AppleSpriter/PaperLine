#!/usr/bin/env python3
"""Exercise a macOS app, Windows install folder, or helper without user data."""
import json
import pathlib
import subprocess
import sys
import tempfile

bundle = pathlib.Path(sys.argv[1]).resolve()
if bundle.is_file():
    helper = bundle
elif (bundle / "Contents" / "MacOS" / "paperline-backend").is_file():
    helper = bundle / "Contents" / "MacOS" / "paperline-backend"
else:
    helper = bundle / "paperline-backend.exe"
if not helper.is_file():
    raise SystemExit(f"Packaged backend not found: {helper}")
with tempfile.TemporaryDirectory(prefix="paperline-bundle-smoke-") as directory:
    requests = [
        {"id": 1, "method": "GET", "path": "/api/desktop/info", "body": {}},
        {"id": 2, "method": "GET", "path": "/api/state", "body": {}},
        {"id": 3, "method": "POST", "path": "/api/desktop/shutdown", "body": {}},
    ]
    result = subprocess.run(
        [str(helper), "--data-dir", directory],
        input="".join(json.dumps(request) + "\n" for request in requests),
        text=True, encoding="utf-8", capture_output=True, timeout=45,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if result.returncode:
        raise SystemExit(f"Packaged backend failed ({result.returncode}):\n{result.stderr}")
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert replies[0] == {"ready": True, "protocol": 1}, replies
    for request, reply in zip(requests, replies[1:]):
        assert reply["id"] == request["id"] and reply["status"] == 200, reply
    assert len(replies) == 4, replies
    assert replies[2]["data"]["version"] == 2, replies[2]
    assert pathlib.Path(replies[1]["data"]["dataDir"]).resolve() == pathlib.Path(directory).resolve(), replies[1]
print(f"Packaged backend passed startup, API, and graceful shutdown: {bundle}")
