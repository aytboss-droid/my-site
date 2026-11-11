"""서버 함수 공통: Supabase 로그인 확인 + AI 하루 사용량 + JSON 응답

- 로그인 확인: 브라우저가 보낸 'Authorization: Bearer <토큰>'을 Supabase에 물어 진짜인지 확인
- 사용량: Supabase 함수 use_ai_quota()를 그 사람의 토큰으로 불러 1회 차감 (하루 20회)
- Supabase 주소·공개 키는 브라우저에도 있는 공개 값. secret 키는 쓰지 않음
"""
import json
import os
import urllib.error
import urllib.request

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://tcjhxbfveyfnswiqokpr.supabase.co")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_F7JuTGy1OoAUbvrGvjeg-Q_O16Ed-xJ")
DAILY_LIMIT = 20


def _supabase(path, auth_header, body=None):
    req = urllib.request.Request(
        SUPABASE_URL + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": auth_header, "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=8) as res:
        return json.loads(res.read().decode("utf-8"))


def check_user(auth_header):
    """로그인 토큰이 진짜면 사용자 id, 아니면 None"""
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    try:
        return _supabase("/auth/v1/user", auth_header).get("id")
    except (urllib.error.URLError, ValueError, TimeoutError, AttributeError):
        return None


def use_quota(auth_header):
    """하루 사용량 1회 차감. 남은 횟수(0 이상), 다 썼으면 -1, 확인 실패면 None"""
    try:
        left = _supabase("/rest/v1/rpc/use_ai_quota", auth_header, {"p_limit": DAILY_LIMIT})
        return int(left)
    except (urllib.error.URLError, ValueError, TimeoutError, TypeError):
        return None


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler, max_bytes):
    """요청 본문(JSON) 읽기. 못 읽으면 None"""
    try:
        size = int(handler.headers.get("Content-Length") or 0)
        if size <= 0 or size > max_bytes:
            return None
        data = json.loads(handler.rfile.read(size).decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (ValueError, UnicodeDecodeError):
        return None


def guard(handler):
    """로그인 확인 + 사용량 차감. 통과하면 남은 횟수, 막히면 응답을 보내고 None"""
    auth = handler.headers.get("Authorization")
    if not check_user(auth):
        send_json(handler, 401, {"error": "로그인한 사람만 쓸 수 있어요"})
        return None
    left = use_quota(auth)
    if left is None:
        send_json(handler, 503, {"error": "사용량을 확인하지 못했어요. 잠시 뒤에 다시 해 주세요"})
        return None
    if left < 0:
        send_json(handler, 429, {"error": "오늘 AI 사용 횟수(" + str(DAILY_LIMIT) + "회)를 다 썼어요. 내일 다시 써 주세요"})
        return None
    return left
