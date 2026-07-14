#!/usr/bin/env python3
# Static server for the dstars-port host that disables caching, so browser reloads always
# fetch fresh ES modules (the default http.server lets browsers cache modules aggressively).
import functools, http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
ROOT = os.path.dirname(os.path.abspath(__file__))

import json, glob

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def do_GET(self):
        # /api/profiles -> list the facility-config XMLs in ./profiles (the home screen's picker).
        if self.path.split("?")[0] == "/api/profiles":
            names = sorted(os.path.splitext(os.path.basename(p))[0]
                           for p in glob.glob(os.path.join(ROOT, "profiles", "*.xml")))
            body = json.dumps({"profiles": names}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()
    def log_message(self, *a):  # quiet
        pass

Handler = functools.partial(NoCacheHandler, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"dstars-port host: http://127.0.0.1:{PORT}/host.html  (no-cache, root={ROOT})")
    httpd.serve_forever()
