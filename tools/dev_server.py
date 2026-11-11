"""내 컴퓨터에서 사이트 + 서버 함수(api/*.py)를 함께 띄우는 시험용 서버

    py tools/dev_server.py        → http://localhost:5600

- 시험용이라 로그인 확인과 하루 사용량은 건너뜀 (Vercel 실제 사이트에서는 항상 확인함)
- Gemini 키는 .env에서 읽으므로 실제로 Gemini를 부름
- 이 파일은 tools/ 안에 있어서 Vercel에 올라가지 않음
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import _auth  # noqa: E402

_auth.check_user = lambda header: "dev-user"
_auth.use_quota = lambda header: 99
import ai  # noqa: E402
import travel_tip  # noqa: E402

ROUTES = {"/api/ai": ai.handler, "/api/travel_tip": travel_tip.handler}


class Dev(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_POST(self):
        h = ROUTES.get(self.path.split("?")[0])
        if not h:
            self.send_error(404)
            return
        h.do_POST(self)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5600"))
    print("http://localhost:%d (로그인·사용량 확인 없이 시험)" % port)
    ThreadingHTTPServer(("127.0.0.1", port), Dev).serve_forever()
