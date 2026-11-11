"""Gemini API 연결 (설정 읽기 + 호출)

- 내 컴퓨터: 프로젝트 맨 위의 .env 파일에서 GEMINI_API_KEY, GEMINI_MODEL을 읽음
- Vercel: 대시보드 Settings → Environment Variables에 같은 이름으로 넣은 값을 읽음
- 키는 서버(이 파일)에서만 씀. 브라우저용 js 파일에는 절대 넣지 않음

파일 이름이 _(밑줄)로 시작해서 Vercel이 바깥에 주소(/api/...)로 열지 않음.
나중에 api/어떤기능.py 를 만들어 여기 있는 generate()를 불러 쓰면 됨.
"""
import os
from pathlib import Path

try:  # 내 컴퓨터에서만 필요 (Vercel에서는 환경 변수가 이미 들어 있음)
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

DEFAULT_MODEL = "gemini-3.5-flash-lite"


class GeminiConfigError(RuntimeError):
    """키가 없는 등 설정 문제"""


def get_config():
    """(API 키, 모델 이름)을 돌려줌. 키가 없으면 GeminiConfigError"""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    model = os.getenv("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    if not key or key.startswith("여기에"):
        raise GeminiConfigError(
            "GEMINI_API_KEY가 없어요. 프로젝트 맨 위 .env 파일에 키를 넣어 주세요 "
            "(Vercel에서는 Settings → Environment Variables)."
        )
    return key, model


_client = None


def get_client():
    """Gemini 클라이언트 (한 번 만들어 다시 씀)"""
    global _client
    if _client is None:
        from google import genai

        key, _ = get_config()
        _client = genai.Client(api_key=key)
    return _client


def generate(prompt, model=None):
    """글을 보내고 Gemini의 답 글을 돌려줌"""
    _, default_model = get_config()
    res = get_client().models.generate_content(model=model or default_model, contents=prompt)
    return res.text
