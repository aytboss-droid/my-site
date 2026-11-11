"""Gemini 연결 확인

사용법 (PowerShell, 프로젝트 맨 위에서):
    py tools/gemini_check.py            설정만 확인 (키가 있는지, 모델 이름)
    py tools/gemini_check.py --call     실제로 한 번 물어보기 (사용량이 조금 듦)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))
import _gemini  # noqa: E402

try:
    key, model = _gemini.get_config()
except _gemini.GeminiConfigError as e:
    print("❌", e)
    sys.exit(1)

print("✅ 키 있음 (" + key[:4] + "…" + str(len(key)) + "자), 모델:", model)

if "--call" in sys.argv:
    print("Gemini 답:", _gemini.generate("한국 가을 여행지 한 곳을 한 문장으로 추천해 줘."))
